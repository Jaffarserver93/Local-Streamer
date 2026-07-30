/**
 * videos.ts
 *
 * Routes:
 *   GET  /api/videos          — list video files in the current VIDEO_DIR
 *   GET  /api/video-dir       — return the current VIDEO_DIR path
 *   POST /api/set-video-dir   — change VIDEO_DIR at runtime (no restart needed)
 *   GET  /video/:filename     — stream a video with HTTP 206 Range support
 */

import { Router, type IRouter, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * VIDEO_DIR — runtime-mutable video directory.
 *
 * Default: the `videos/` folder next to the built output.
 * Change at launch via env: VIDEO_DIR=/sdcard/Download node dist/index.mjs
 * Change at runtime: POST /api/set-video-dir { "path": "/your/folder" }
 *
 * Examples:
 *   VIDEO_DIR=/sdcard/Download           # Android downloads
 *   VIDEO_DIR=/media/usb0/Movies         # USB drive on Linux
 *   VIDEO_DIR=/Volumes/MyDrive/Videos    # macOS external drive
 */
let currentVideoDir: string =
  process.env["VIDEO_DIR"] ?? path.join(__dirname, "..", "videos");

/** Supported MIME types keyed by lowercase file extension */
const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
};

const SUPPORTED_EXTS = new Set(Object.keys(MIME_TYPES));

/** Default byte chunk when the Range header has no end byte (1 MB) */
const DEFAULT_CHUNK = 1024 * 1024;

/** CORS headers required so Chromecast (cross-origin iframe) can stream */
const STREAM_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers":
    "Content-Range, Accept-Ranges, Content-Length, Content-Type",
};

const router: IRouter = Router();

// ─── GET /api/video-dir ───────────────────────────────────────────────────────
/** Returns the path that is currently being served. */
router.get("/api/video-dir", (_req: Request, res: Response) => {
  res.json({ path: currentVideoDir });
});

// ─── POST /api/set-video-dir ──────────────────────────────────────────────────
/**
 * Changes the video directory at runtime — no server restart needed.
 * Body: { "path": "/absolute/path/to/your/videos" }
 */
router.post("/api/set-video-dir", (req: Request, res: Response) => {
  const newPath: unknown = (req.body as Record<string, unknown>)["path"];

  if (!newPath || typeof newPath !== "string" || !newPath.trim()) {
    res.status(400).json({ error: "Request body must contain a non-empty `path` string." });
    return;
  }

  const trimmed = newPath.trim();

  if (!fs.existsSync(trimmed)) {
    res
      .status(404)
      .json({ error: `Directory not found: "${trimmed}". Check the path and try again.` });
    return;
  }

  const stat = fs.statSync(trimmed);
  if (!stat.isDirectory()) {
    res.status(400).json({ error: `"${trimmed}" is a file, not a directory.` });
    return;
  }

  currentVideoDir = trimmed;
  res.json({ success: true, path: currentVideoDir });
});

// ─── GET /api/videos ─────────────────────────────────────────────────────────
/**
 * Lists all supported video files in currentVideoDir.
 * Response: [{ filename: "movie.mp4" }, ...]
 */
router.get("/api/videos", (_req: Request, res: Response) => {
  if (!fs.existsSync(currentVideoDir)) {
    res.status(404).json({
      error:
        `Video directory not found: "${currentVideoDir}". ` +
        `Use POST /api/set-video-dir to point to your videos folder.`,
    });
    return;
  }

  let files: string[];
  try {
    files = fs.readdirSync(currentVideoDir);
  } catch (err) {
    res.status(500).json({ error: `Cannot read directory: ${String(err)}` });
    return;
  }

  const videos = files
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) return false;
      try {
        return fs.statSync(path.join(currentVideoDir, f)).isFile();
      } catch {
        return false;
      }
    })
    .map((filename) => ({ filename }));

  res.json(videos);
});

// ─── GET /video/:filename ─────────────────────────────────────────────────────
/**
 * Streams a video with HTTP 206 Partial Content (Range) support.
 *
 * Why Range support is mandatory:
 *   • Smart TV browsers refuse to play without it
 *   • Chromecast Cast SDK ONLY uses Range requests
 *   • Without it, scrubbing / seeking is completely broken
 */
router.get("/video/:filename", (req: Request, res: Response) => {
  const rawName = req.params["filename"] ?? "";
  const safeName = path.basename(rawName); // prevent path traversal
  const videoPath = path.join(currentVideoDir, safeName);

  const ext = path.extname(safeName).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    res.status(400).json({ error: `Unsupported type "${ext}". Allowed: mp4, mkv, webm.` });
    return;
  }

  if (!fs.existsSync(videoPath)) {
    res.status(404).json({ error: `Not found: "${safeName}"` });
    return;
  }

  const { size: fileSize } = fs.statSync(videoPath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const rangeHeader = req.headers["range"];

  if (rangeHeader) {
    // ── 206 Partial Content ───────────────────────────────────────────────
    const [s, e] = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(s ?? "0", 10);
    const end = e ? parseInt(e, 10) : Math.min(start + DEFAULT_CHUNK - 1, fileSize - 1);

    if (isNaN(start) || isNaN(end) || start < 0 || end >= fileSize || start > end) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      res.status(416).end();
      return;
    }

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType,
      ...STREAM_CORS,
    });

    const stream = fs.createReadStream(videoPath, { start, end });
    stream.pipe(res);
    stream.on("error", (err) => { if (!res.writableEnded) res.destroy(err as Error); });
  } else {
    // ── 200 Full file ─────────────────────────────────────────────────────
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      ...STREAM_CORS,
    });

    const stream = fs.createReadStream(videoPath);
    stream.pipe(res);
    stream.on("error", (err) => { if (!res.writableEnded) res.destroy(err as Error); });
  }
});

export default router;
export { currentVideoDir };
