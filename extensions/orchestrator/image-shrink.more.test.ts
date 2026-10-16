import { describe, expect, it } from "vitest";
import type { ImagesConfig } from "./config.js";
import { readImageSize, shrinkImages } from "./image-shrink.js";

function sof(marker: number, width: number, height: number): Buffer {
  const frame = Buffer.alloc(11);
  frame.writeUInt16BE(0xff00 | marker, 0);
  frame.writeUInt16BE(9, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return frame;
}

function segment(marker: number, payload = 2): Buffer {
  const out = Buffer.alloc(4 + payload);
  out.writeUInt16BE(0xff00 | marker, 0);
  out.writeUInt16BE(2 + payload, 2);
  return out;
}

const SOI = Buffer.from([0xff, 0xd8]);

describe("readImageSize on JPEG marker streams", () => {
  it("skips fill bytes and standalone markers before the frame header", () => {
    const bytes = Buffer.concat([SOI, Buffer.from([0xff, 0xff, 0xff]), Buffer.from([0xd0]), Buffer.from([0xff, 0xd8]), sof(0xc2, 640, 480)]);
    expect(readImageSize(bytes)).toEqual({ width: 640, height: 480 });
  });

  it("does not mistake a Huffman table or arithmetic coding segment for a frame", () => {
    const bytes = Buffer.concat([SOI, segment(0xc4, 8), segment(0xcc, 4), segment(0xc8, 4), sof(0xc1, 300, 200)]);
    expect(readImageSize(bytes)).toEqual({ width: 300, height: 200 });
  });

  it("gives up on a stream that loses marker sync", () => {
    const bytes = Buffer.concat([SOI, Buffer.from([0x00, 0x11]), sof(0xc0, 10, 10)]);
    expect(readImageSize(bytes)).toBeNull();
  });

  it("returns null for a JPEG truncated before any frame header", () => {
    expect(readImageSize(Buffer.concat([SOI, segment(0xe0, 2)]))).toBeNull();
  });
});

describe("shrinkImages with undecodable images", () => {
  const settings: ImagesConfig = { enabled: true, maxEdge: 1568, maxVisualTokens: 1568, jpegQuality: 80, maxBytes: 1024 };

  it("leaves an image the resizer cannot decode exactly as it was", async () => {
    const garbage = { type: "image" as const, data: Buffer.alloc(4096, 7).toString("base64"), mimeType: "image/webp" };
    expect(await shrinkImages([{ type: "text", text: "t" }, garbage], settings)).toBeNull();
  });
});
