import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImagesConfig } from "./config.js";
import { getLogger } from "./log.js";

type ImageBlock = { type: "image"; data: string; mimeType: string };
type ResultBlock = { type: "text"; text: string } | ImageBlock;

interface ResizeResult {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  wasResized: boolean;
}

interface ResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  jpegQuality?: number;
}

type ResizeImage = (bytes: Uint8Array, mimeType: string, options?: ResizeOptions) => Promise<ResizeResult | null>;

// Claude measures an image in 28px patches, and both of its limits are
// expressed in those units.
const PATCH = 28;

let resizerOnce: Promise<ResizeImage | null> | undefined;

// pi's resizer is absent from its package export map, so it is reached by file
// URL beside the resolved entry point. A host that moves it leaves images
// untouched rather than failing every tool result that carries one.
function loadResizer(): Promise<ResizeImage | null> {
  resizerOnce ??= (async () => {
    try {
      const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
      const module: { resizeImage?: ResizeImage } = await import(new URL("./utils/image-resize.js", entry).href);
      if (typeof module.resizeImage === "function") return module.resizeImage;
      getLogger().warn({ s: "images" }, "pi exposes no resizeImage; images pass through untouched");
      return null;
    } catch (error: any) {
      getLogger().warn({ s: "images", err: error?.message }, "pi image resizer unavailable; images pass through untouched");
      return null;
    }
  })();
  return resizerOnce;
}

/**
 * Dimensions from an image header, or null for a format this does not read.
 * Only the headers are parsed: the pixels are never decoded.
 */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) {
        offset++;
        continue;
      }
      // Every start-of-frame marker but DHT (0xc4), DNL (0xc8) and DAC (0xcc)
      // carries the frame's dimensions in the same place.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return null;
}

/**
 * The largest aspect-preserving size that fits both of Claude's standard-tier
 * limits: neither padded edge over maxEdge, and no more than maxVisualTokens
 * patches. Claude applies this rule itself on arrival, so an image sent at this
 * size reaches the model unchanged; anything larger is resampled twice.
 */
export function fittedSize(width: number, height: number, maxEdge: number, maxVisualTokens: number): { width: number; height: number } {
  const fits = (w: number, h: number): boolean =>
    Math.ceil(w / PATCH) * PATCH <= maxEdge &&
    Math.ceil(h / PATCH) * PATCH <= maxEdge &&
    Math.ceil(w / PATCH) * Math.ceil(h / PATCH) <= maxVisualTokens;
  if (fits(width, height)) return { width, height };
  if (height > width) {
    const rotated = fittedSize(height, width, maxEdge, maxVisualTokens);
    return { width: rotated.height, height: rotated.width };
  }
  const aspect = width / height;
  const shortEdge = (longEdge: number) => Math.max(Math.round(longEdge / aspect), 1);
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, shortEdge(mid))) lo = mid;
    else hi = mid;
  }
  return { width: lo, height: shortEdge(lo) };
}

async function shrinkBlock(resize: ResizeImage, block: ImageBlock, settings: ImagesConfig): Promise<ImageBlock | null> {
  const bytes = new Uint8Array(Buffer.from(block.data, "base64"));
  const size = readImageSize(bytes);
  const target = size ? fittedSize(size.width, size.height, settings.maxEdge, settings.maxVisualTokens) : null;
  const overBytes = Buffer.byteLength(block.data, "utf-8") > settings.maxBytes;
  if (target && target.width === size!.width && target.height === size!.height && !overBytes) return null;
  const resized = await resize(bytes, block.mimeType, {
    maxWidth: target?.width ?? settings.maxEdge,
    maxHeight: target?.height ?? settings.maxEdge,
    maxBytes: settings.maxBytes,
    jpegQuality: settings.jpegQuality,
  });
  // Photon's PNG encoder can spend more bytes than the one that produced the
  // image, so a "shrunk" result that grew is dropped rather than sent.
  if (!resized || resized.data.length >= block.data.length) return null;
  getLogger().debug(
    { s: "images", from: `${resized.originalWidth}x${resized.originalHeight}`, to: `${resized.width}x${resized.height}`, savedKb: Math.round((block.data.length - resized.data.length) / 1024) },
    "shrank tool result image",
  );
  return { type: "image", data: resized.data, mimeType: resized.mimeType };
}

/**
 * Tool result content with every image shrunk, or null when nothing changed.
 */
export async function shrinkImages(content: readonly ResultBlock[], settings: ImagesConfig): Promise<ResultBlock[] | null> {
  if (!content.some((block) => block.type === "image")) return null;
  const resize = await loadResizer();
  if (!resize) return null;
  const out: ResultBlock[] = [];
  let changed = false;
  for (const block of content) {
    if (block.type !== "image") {
      out.push(block);
      continue;
    }
    let shrunk: ImageBlock | null = null;
    try {
      shrunk = await shrinkBlock(resize, block, settings);
    } catch (error: any) {
      getLogger().warn({ s: "images", err: error?.message }, "shrinking a tool result image failed");
    }
    if (shrunk) changed = true;
    out.push(shrunk ?? block);
  }
  return changed ? out : null;
}

export function registerImageShrink(pi: ExtensionAPI, getSettings: () => ImagesConfig | undefined): void {
  pi.on("tool_result", async (event: any) => {
    const settings = getSettings();
    if (!settings?.enabled) return;
    const content = await shrinkImages(event.content as ResultBlock[], settings);
    if (!content) return;
    return { content: content as any };
  });
}
