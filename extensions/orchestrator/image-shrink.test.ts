import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import type { ImagesConfig } from "./config.js";
import { fittedSize, readImageSize, registerImageShrink, shrinkImages } from "./image-shrink.js";

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, checksum]);
}

/** A real 8-bit RGB PNG of deterministic noise, so it compresses like a screenshot. */
function noisePng(width: number, height: number): Buffer {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 3; x++) {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0;
      raw[y * stride + 1 + x] = (seed >>> 16) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpegHeader(width: number, height: number): Buffer {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x04]), Buffer.alloc(2)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function imageBlock(bytes: Buffer, mimeType = "image/png") {
  return { type: "image" as const, data: bytes.toString("base64"), mimeType };
}

const settings = (over: Partial<ImagesConfig> = {}): ImagesConfig => ({
  enabled: true,
  maxEdge: 1568,
  maxVisualTokens: 1568,
  jpegQuality: 90,
  maxBytes: 768 * 1024,
  ...over,
});

describe("fittedSize", () => {
  // Claude's published standard-tier examples. Matching them exactly is the
  // point: a shrunk image then arrives at the size the model uses anyway.
  it.each([
    [1920, 1080, 1456, 819],
    [3840, 2160, 1456, 819],
    [2000, 1500, 1269, 952],
    [1075, 1520, 924, 1307],
  ])("resizes %ix%i to %ix%i", (width, height, expectedWidth, expectedHeight) => {
    expect(fittedSize(width, height, 1568, 1568)).toEqual({ width: expectedWidth, height: expectedHeight });
  });

  it.each([
    [200, 200],
    [1000, 1000],
    [1092, 1092],
  ])("leaves %ix%i alone", (width, height) => {
    expect(fittedSize(width, height, 1568, 1568)).toEqual({ width, height });
  });

  it("caps the long edge of a tall screenshot", () => {
    const fitted = fittedSize(1080, 2400, 1568, 1568);
    expect(Math.ceil(fitted.height / 28) * 28).toBeLessThanOrEqual(1568);
    expect(Math.ceil(fitted.width / 28) * Math.ceil(fitted.height / 28)).toBeLessThanOrEqual(1568);
  });

  it("honours a tier raised to high resolution", () => {
    expect(fittedSize(1920, 1080, 2576, 4784)).toEqual({ width: 1920, height: 1080 });
    expect(fittedSize(3840, 2160, 2576, 4784)).toEqual({ width: 2576, height: 1449 });
  });
});

describe("readImageSize", () => {
  it("reads PNG dimensions", () => {
    expect(readImageSize(noisePng(64, 48))).toEqual({ width: 64, height: 48 });
  });

  it("reads JPEG dimensions past an earlier segment", () => {
    expect(readImageSize(jpegHeader(1234, 567))).toEqual({ width: 1234, height: 567 });
  });

  it("returns null for a format it does not parse", () => {
    expect(readImageSize(Buffer.from("RIFF____WEBPVP8 ", "ascii"))).toBeNull();
    expect(readImageSize(Buffer.alloc(4))).toBeNull();
  });
});

describe("shrinkImages", () => {
  it("leaves content without images alone", async () => {
    const content = [{ type: "text" as const, text: "no pictures here" }];
    expect(await shrinkImages(content, settings())).toBeNull();
  });

  it("leaves an image that already fits both limits", async () => {
    const content = [imageBlock(noisePng(64, 48))];
    expect(await shrinkImages(content, settings())).toBeNull();
  });

  it("shrinks an oversized image and keeps the other blocks in place", async () => {
    const original = imageBlock(noisePng(400, 600));
    const content = [{ type: "text" as const, text: "before" }, original, { type: "text" as const, text: "after" }];
    const shrunk = await shrinkImages(content, settings({ maxEdge: 280, maxVisualTokens: 100 }));
    expect(shrunk).not.toBeNull();
    expect(shrunk!.map((block) => block.type)).toEqual(["text", "image", "text"]);
    expect(shrunk![0]).toBe(content[0]);
    expect(shrunk![2]).toBe(content[2]);
    const image = shrunk![1] as { type: "image"; data: string; mimeType: string };
    expect(image.data.length).toBeLessThan(original.data.length);
    expect(readImageSize(Buffer.from(image.data, "base64"))?.width ?? 0).toBeLessThanOrEqual(280);
  });

  it("re-encodes an image whose dimensions fit but whose payload is too large", async () => {
    const original = imageBlock(noisePng(400, 600));
    const shrunk = await shrinkImages([original], settings({ maxBytes: 64 * 1024 }));
    expect(shrunk).not.toBeNull();
    const image = shrunk![0] as { type: "image"; data: string; mimeType: string };
    expect(Buffer.byteLength(image.data, "utf-8")).toBeLessThan(64 * 1024);
    expect(image.mimeType).toBe("image/jpeg");
  });
});

describe("registerImageShrink", () => {
  function fakePi() {
    const handlers: Array<(event: any) => Promise<any>> = [];
    return {
      handlers,
      on(event: string, handler: (event: any) => Promise<any>) {
        if (event === "tool_result") handlers.push(handler);
      },
    };
  }

  it("rewrites a tool result carrying an oversized image", async () => {
    const pi = fakePi();
    registerImageShrink(pi as any, () => settings({ maxEdge: 280, maxVisualTokens: 100 }));
    const content = [imageBlock(noisePng(400, 600))];
    const result = await pi.handlers[0]!({ toolName: "bash", content });
    expect(result.content[0].data.length).toBeLessThan(content[0]!.data.length);
  });

  it("does nothing when shrinking is switched off", async () => {
    const pi = fakePi();
    registerImageShrink(pi as any, () => settings({ enabled: false, maxEdge: 280, maxVisualTokens: 100 }));
    expect(await pi.handlers[0]!({ toolName: "bash", content: [imageBlock(noisePng(400, 600))] })).toBeUndefined();
  });

  it("does nothing when no settings are available yet", async () => {
    const pi = fakePi();
    registerImageShrink(pi as any, () => undefined);
    expect(await pi.handlers[0]!({ toolName: "bash", content: [imageBlock(noisePng(400, 600))] })).toBeUndefined();
  });
});
