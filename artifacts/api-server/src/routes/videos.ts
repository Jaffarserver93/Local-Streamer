/**
 * videos.ts
 *
 * Routes:
 *   GET  /api/videos          — list video files in currentVideoDir
 *   GET  /api/video-dir       — return currentVideoDir path
 *   POST /api/set-video-dir   — change currentVideoDir at runtime
 *   POST /api/upload          — upload a video file to the library
 *   POST /api/faststart/:fn   — remux MP4 in-place for faster start
 *   GET  /video/:filename     — HTTP 206 Range streaming
 *
 * Each browser session is fully independent — no shared playback state.
 * Socket.io is only used for library change notifications (upload, faststart).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { type Server as IOServer } from "socket.io";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * VIDEO_DIR — folder the server reads & writes video files from/to.
 * Change at runtime via POST /api/set-video-dir.
 *
 *   VIDEO_DIR=/sdcard/Download node dist/index.mjs      # Android – Downloads
 *   VIDEO_DIR=/sdcard/MOVIEBOX  node dist/index.mjs      # Android – MovieBox
 *   VIDEO_DIR=/Volumes/USB/Movies node dist/index.mjs    # macOS external drive
 */
let currentVideoDir: string =
  process.env["VIDEO_DIR"] ?? path.join(__dirname, "..", "videos");

// All extensions we can stream directly (browser-native or via transcode)
const MIME_TYPES: Record<string, string> = {
  ".mp4":  "video/mp4",
  ".m4v":  "video/mp4",
  ".mkv":  "video/x-matroska",
  ".webm": "video/webm",
  ".mov":  "video/quicktime",
  ".avi":  "video/x-msvideo",
  ".wmv":  "video/x-ms-wmv",
  ".flv":  "video/x-flv",
  ".ts":   "video/mp2t",
  ".3gp":  "video/3gpp",
  ".3g2":  "video/3gpp2",
  ".ogv":  "video/ogg",
  ".m2ts": "video/mp2t",
  ".mts":  "video/mp2t",
};

const NATIVE_EXTS   = new Set([".mp4", ".m4v", ".webm", ".mov"]);
const SUPPORTED_EXTS = new Set(Object.keys(MIME_TYPES));

// ── MP4 faststart (moov atom) detection ───────────────────────────────────────
/**
 * Returns true if the file is an MP4/MOV whose moov atom sits AFTER mdat.
 * When moov is at the end, the browser can't start decoding until it has
 * downloaded the whole file → stuttering every second.
 * Fix: ffmpeg -i in.mp4 -c copy -movflags +faststart -y out.mp4
 */
function checkNeedsFaststart(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".mp4" && ext !== ".m4v" && ext !== ".mov") return false;
  try {
    const fd  = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(16);
    let offset = 0;
    // Scan the top-level atom list (first ~4 MB max)
    while (offset < 4 * 1024 * 1024) {
      const n = fs.readSync(fd, buf, 0, 16, offset);
      if (n < 8) break;
      const size = buf.readUInt32BE(0);
      const type = buf.toString("ascii", 4, 8);
      if (type === "moov") { fs.closeSync(fd); return false; } // moov first = fine
      if (type === "mdat") { fs.closeSync(fd); return true;  } // mdat first = needs fix
      // Skip atom: handle extended-size (size === 1 means 64-bit size follows)
      const advance = size === 1
        ? Number(buf.readBigUInt64BE(8))   // extended 64-bit atom size
        : size < 8 ? 8 : size;            // guard against malformed size=0
      offset += advance;
    }
    fs.closeSync(fd);
    return false;
  } catch { return false; }
}

// ── Socket.io instance ─────────────────────────────────────────────────────────
let io: IOServer | null = null;

/** Called from index.ts after the Socket.io server is created. */
export function setIO(ioInstance: IOServer): void {
  io = ioInstance;
}

/** Notify all clients of library changes (upload, faststart). */
function broadcast(event: string, data: unknown): void {
  io?.emit(event, data);
}

// ── ffmpeg transcoding ─────────────────────────────────────────────────────────
function transcodeToMp4(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      const ffmpegArgs: string[] = [
        "-y",
        "-loglevel", "error",
        "-i", input,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        output,
      ].filter(Boolean);
      proc = spawn("ffmpeg", ffmpegArgs);
    } catch (e) { reject(e); return; }
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
    proc.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") reject(new Error("ffmpeg not found — install it: pkg install ffmpeg"));
      else reject(e);
    });
  });
}

const STREAM_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers":
    "Content-Range, Accept-Ranges, Content-Length, Content-Type",
};

// ── Multer upload config ───────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    if (!fs.existsSync(currentVideoDir)) {
      fs.mkdirSync(currentVideoDir, { recursive: true });
    }
    cb(null, currentVideoDir);
  },
  filename(_req, file, cb) {
    const safe = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9._\-\s]/g, "_")
      .trim();
    cb(null, safe || `upload_${Date.now()}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024 }, // 20 GB
});

const router: IRouter = Router();

// ── GET /api/video-dir ─────────────────────────────────────────────────────────
router.get("/api/video-dir", (_req: Request, res: Response) => {
  res.json({ path: currentVideoDir });
});

// ── POST /api/set-video-dir ────────────────────────────────────────────────────
router.post("/api/set-video-dir", (req: Request, res: Response) => {
  const body    = req.body as Record<string, unknown>;
  const newPath = body["path"];

  if (!newPath || typeof newPath !== "string" || !newPath.trim()) {
    res.status(400).json({ error: "Body must contain { path: string }" });
    return;
  }

  const trimmed = newPath.trim();
  if (!fs.existsSync(trimmed)) {
    res.status(404).json({ error: `Directory not found: "${trimmed}"` });
    return;
  }
  if (!fs.statSync(trimmed).isDirectory()) {
    res.status(400).json({ error: `"${trimmed}" is a file, not a directory.` });
    return;
  }

  currentVideoDir = trimmed;
  res.json({ success: true, path: currentVideoDir });
});

// ── GET /api/videos ────────────────────────────────────────────────────────────
router.get("/api/videos", (_req: Request, res: Response) => {
  if (!fs.existsSync(currentVideoDir)) {
    res.status(404).json({
      error: `Video directory not found: "${currentVideoDir}". Use POST /api/set-video-dir or upload a file.`,
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
      if (!SUPPORTED_EXTS.has(path.extname(f).toLowerCase())) return false;
      try { return fs.statSync(path.join(currentVideoDir, f)).isFile(); } catch { return false; }
    })
    .map((filename) => ({
      filename,
      needsFaststart: checkNeedsFaststart(path.join(currentVideoDir, filename)),
    }));

  res.json(videos);
});

// ── POST /api/upload ───────────────────────────────────────────────────────────
router.post("/api/upload", (req: Request, res: Response) => {
  upload.single("video")(req, res, (err: unknown) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "No file received." });
      return;
    }

    const ext          = path.extname(file.filename).toLowerCase();
    const needsTranscode = !NATIVE_EXTS.has(ext);

    if (!needsTranscode) {
      broadcast("library-updated", {});
      res.json({ success: true, filename: file.filename, transcoding: false });
      return;
    }

    const mp4Name = file.filename.replace(/\.[^.]+$/, "") + ".mp4";
    const mp4Path = path.join(currentVideoDir, mp4Name);
    res.json({ success: true, filename: mp4Name, transcoding: true });

    transcodeToMp4(file.path, mp4Path)
      .then(() => { fs.unlink(file.path, () => {}); broadcast("library-updated", {}); })
      .catch((e) => { console.error("Transcode failed:", e); broadcast("library-updated", {}); });
  });
});

// ── POST /api/faststart/:filename ─────────────────────────────────────────────
/**
 * Remux an MP4 in-place with -movflags +faststart so the moov atom moves to
 * the front of the file. This eliminates the 1-second-play / buffer / repeat
 * cycle on large files.
 *
 * Flow:
 *   1. Write remuxed output to a .tmp file next to the original
 *   2. Replace original with the .tmp file on success
 *   3. Broadcast faststart-done or faststart-error via Socket.io
 */
router.post("/api/faststart/:filename", (req: Request, res: Response) => {
  const safeName  = path.basename(String(req.params["filename"] || ""));
  const videoPath = path.join(currentVideoDir, safeName);
  const ext       = path.extname(safeName).toLowerCase();

  if (!fs.existsSync(videoPath)) {
    res.status(404).json({ error: `Not found: "${safeName}"` });
    return;
  }
  if (ext !== ".mp4" && ext !== ".m4v" && ext !== ".mov") {
    res.status(400).json({ error: "Only MP4/MOV files can be fixed." });
    return;
  }
  if (!checkNeedsFaststart(videoPath)) {
    res.json({ success: true, message: "File already has faststart — no action needed." });
    return;
  }

  const tmpPath = videoPath + ".fstmp.mp4";
  res.json({ success: true, started: true });

  let proc: ReturnType<typeof spawn>;
  try {
    const ffmpegArgs: string[] = [
      "-y",
      "-loglevel", "error",
      "-i",  videoPath,
      "-c",  "copy",
      "-movflags", "+faststart",
      tmpPath,
    ].filter(Boolean);
    proc = spawn("ffmpeg", ffmpegArgs);
  } catch (e) {
    broadcast("faststart-error", { filename: safeName, error: String(e) });
    return;
  }

  proc.on("close", (code) => {
    if (code === 0) {
      try {
        fs.renameSync(tmpPath, videoPath);
        broadcast("faststart-done", { filename: safeName });
        broadcast("library-updated", {});
      } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch {}
        broadcast("faststart-error", { filename: safeName, error: String(e) });
      }
    } else {
      try { fs.unlinkSync(tmpPath); } catch {}
      broadcast("faststart-error", { filename: safeName, error: `ffmpeg exited ${code}` });
    }
  });

  proc.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") {
      broadcast("faststart-error", {
        filename: safeName,
        error: "ffmpeg not found — install it first: pkg install ffmpeg",
      });
    } else {
      broadcast("faststart-error", { filename: safeName, error: e.message });
    }
  });
});

// ── POST /api/client-log ───────────────────────────────────────────────────────
/**
 * Log client-side errors (Video.js failures, mobile playback errors, network issues)
 * to server logs for diagnostics.
 */
router.post("/api/client-log", (req: Request, res: Response) => {
  const body = (req.body as Record<string, unknown>) || {};
  const level = String(body["level"] || "error");
  const message = String(body["message"] || "Client Log Event");
  const filename = String(body["filename"] || "");
  const code = body["code"];
  const src = String(body["src"] || "");
  const userAgent = String(req.headers["user-agent"] || "");

  console.log(`[CLIENT-LOG] [${level.toUpperCase()}] ${message} | File: "${filename}" | Code: ${code} | Src: ${src} | UA: ${userAgent}`);
  res.json({ ok: true });
});

// ── GET /video/:filename ───────────────────────────────────────────────────────
/**
 * HTTP 206 Range streaming.
 * Required for: video seeking in all browsers, Smart TV compatibility,
 * and Chromecast (Cast SDK only uses Range requests).
 */
router.get("/video/:filename", (req: Request, res: Response) => {
  const safeName  = path.basename(String(req.params["filename"] || ""));
  const videoPath = path.join(currentVideoDir, safeName);
  const ext       = path.extname(safeName).toLowerCase();

  if (!SUPPORTED_EXTS.has(ext)) {
    res.status(400).json({ error: `Unsupported type "${ext}".` });
    return;
  }
  if (!fs.existsSync(videoPath)) {
    res.status(404).json({ error: `Not found: "${safeName}"` });
    return;
  }

  const { size: fileSize } = fs.statSync(videoPath);
  const contentType        = MIME_TYPES[ext] ?? "application/octet-stream";
  const rangeHeader        = req.headers["range"];

  if (rangeHeader) {
    let start = 0;
    let end = fileSize - 1;

    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const rawStart = parts[0]?.trim();
    const rawEnd   = parts[1]?.trim();

    if (!rawStart && rawEnd) {
      // Suffix range request (e.g. bytes=-50000) sent by Android Chrome to read moov atom
      const suffixLen = parseInt(rawEnd, 10);
      start = Math.max(0, fileSize - suffixLen);
      end   = fileSize - 1;
    } else {
      start = rawStart ? parseInt(rawStart, 10) : 0;
      end   = rawEnd ? parseInt(rawEnd, 10) : fileSize - 1;
    }

    if (isNaN(start) || isNaN(end) || start < 0 || end >= fileSize || start > end) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      res.status(416).end();
      return;
    }

    res.writeHead(206, {
      "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges":  "bytes",
      "Content-Length": end - start + 1,
      "Content-Type":   contentType,
      ...STREAM_CORS,
    });

    const stream = fs.createReadStream(videoPath, { start, end });
    stream.pipe(res);
    stream.on("error", (err) => { if (!res.writableEnded) res.destroy(err as Error); });
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type":   contentType,
      "Accept-Ranges":  "bytes",
      ...STREAM_CORS,
    });
    const stream = fs.createReadStream(videoPath);
    stream.pipe(res);
    stream.on("error", (err) => { if (!res.writableEnded) res.destroy(err as Error); });
  }
});

export default router;
export { currentVideoDir };
