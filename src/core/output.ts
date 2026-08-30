import { Buffer } from "node:buffer";

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) end -= 1;
  return { text: encoded.subarray(0, end).toString("utf8"), truncated: true };
}
