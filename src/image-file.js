import crypto from "node:crypto";
import fs from "node:fs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      || bytes.toString("ascii", 12, 16) !== "IHDR"
      || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") return null;
  return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8
      || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (length < 7) return null;
      return {
        format: "jpeg",
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

export function inspectImageFile(filePath, expected) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("Screenshot output is not a regular file");
  const bytes = fs.readFileSync(filePath);
  const dimensions = expected.format === "png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!dimensions || dimensions.format !== expected.format) {
    throw new Error(`Screenshot output is not a valid ${expected.format.toUpperCase()} image`);
  }
  if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
    throw new Error(`Screenshot output is ${dimensions.width}x${dimensions.height}, expected ${expected.width}x${expected.height}`);
  }
  return {
    ...dimensions,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    lastModified: stat.mtime,
    hash: crypto.createHash("sha256").update(bytes).digest("base64url"),
  };
}
