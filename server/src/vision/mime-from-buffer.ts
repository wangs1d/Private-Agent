/** 与 ALLOWED_MIME（jpeg/png/webp）对齐的简单嗅探 */
export function sniffImageMimeFromBuffer(buf: Buffer, contentTypeHint?: string): string {
  const h = contentTypeHint?.split(";")[0]?.trim().toLowerCase();
  if (h === "image/jpeg" || h === "image/png" || h === "image/webp") {
    return h;
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return "image/jpeg";
}
