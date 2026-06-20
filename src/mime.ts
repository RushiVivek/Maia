/**
 * Map a file extension to a Content-Type. Goal: phones render images/PDFs/text
 * inline; video gets a real video/* type so the browser/VLC treats it as media.
 * Unknown types fall back to octet-stream (download).
 */

const TYPES: Record<string, string> = {
  // images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  // NOTE: .svg is deliberately NOT mapped here — SVG is active content (can
  // carry <script>), so it falls through to application/octet-stream (download)
  // rather than rendering inline. See contentType().
  bmp: "image/bmp",
  ico: "image/x-icon",
  // documents
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  // audio
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  // video
  mp4: "video/mp4",
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  // archives
  zip: "application/zip",
};

const VIDEO_EXTS = new Set(["mp4", "m4v", "mkv", "webm", "mov", "avi"]);

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function contentType(path: string): string {
  return TYPES[extOf(path)] ?? "application/octet-stream";
}

export function isVideo(path: string): boolean {
  return VIDEO_EXTS.has(extOf(path));
}
