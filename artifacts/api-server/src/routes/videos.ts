/**
 * videos.ts
 *
 * Routes:
 *   GET  /api/videos          — list video files in currentVideoDir
 *   GET  /api/video-dir       — return currentVideoDir path
 *   POST /api/set-video-dir   — change currentVideoDir at runtime
 *   POST /api/play            — broadcast "play" to ALL connected clients
 *   POST /api/pause           — broadcast "pause"
 *   POST /api/resume          — broadcast "resume"
 *   POST /api/seek            — broadcast "seek"
 *   POST /api/upload          — upload a video file to the library
 *   GET  /video/:filename     — HTTP 206 Range streaming
 *
 * Socket.io replaces SSE for real-time sync. All state changes are broadcast
 * via io.emit() which Socket.io delivers over WebSocket in <10 ms.
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
const DEFAULT_CHUNK  = 1024 * 1024; // 1 MB per Range request chunk

// ── Global playback state ──────────────────────────────────────────────────────
/**
 * Single in-memory session shared by all connected devices.
 * New tabs receive this state on connect so they jump straight to the right
 * video and position without any manual "join room" step.
 */
let globalState = {
  currentVideo:          null as string | null,
  isPlaying:             false,
  lastPosition:          0,          // seconds at the time lastUpdatedServerTime was recorded
  lastUpdatedServerTime: Date.now(), // server ms timestamp of last position update
};

/** Calculate the live playback position right now (accounts for elapsed time). */
export function livePosition(): number {
  if (!globalState.currentVideo) return 0;
  if (!globalState.isPlaying)    return globalState.lastPosition;
  return globalState.lastPosition + (Date.now() - globalState.lastUpdatedServerTime) / 1000;
}

export function getGlobalState() { return globalState; }

// ── Socket.io instance ─────────────────────────────────────────────────────────
let io: IOServer | null = null;

/** Called from index.ts after the Socket.io server is created. */
export function setIO(ioInstance: IOServer): void {
  io = ioInstance;
}

/**
 * Broadcast a named event with payload to ALL connected clients simultaneously.
 * This is how one phone's tap instantly controls every TV and other phone.
 */
function broadcast(event: string, data: unknown): void {
  io?.emit(event, data);
}

// ── ffmpeg transcoding ─────────────────────────────────────────────────────────
function transcodeToMp4(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("ffmpeg", [
        "-i", input,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-y", output,
      ]);
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

// ── POST /api/play ─────────────────────────────────────────────────────────────
/**
 * Phone taps a library card → POST /api/play → broadcast to all screens.
 * Includes serverTime so clients can apply NTP-corrected position offset.
 */
router.post("/api/play", (req: Request, res: Response) => {
  const body     = req.body as Record<string, unknown>;
  const filename = body["filename"];
  const position = Number(body["position"]) || 0;

  if (!filename || typeof filename !== "string") {
    res.status(400).json({ error: "Body must contain { filename: string }" });
    return;
  }

  const now = Date.now();
  globalState = { currentVideo: filename, isPlaying: true, lastPosition: position, lastUpdatedServerTime: now };
  broadcast("play", { filename, position, serverTime: now, paused: false });
  res.json({ success: true });
});

// ── POST /api/pause ────────────────────────────────────────────────────────────
router.post("/api/pause", (req: Request, res: Response) => {
  const position = Number((req.body as Record<string, unknown>)["position"]) || 0;
  const now = Date.now();
  globalState.isPlaying = false;
  globalState.lastPosition = position;
  globalState.lastUpdatedServerTime = now;
  broadcast("pause", { position, serverTime: now });
  res.json({ success: true });
});

// ── POST /api/resume ───────────────────────────────────────────────────────────
router.post("/api/resume", (req: Request, res: Response) => {
  const position = Number((req.body as Record<string, unknown>)["position"]) || 0;
  const now = Date.now();
  globalState.isPlaying = true;
  globalState.lastPosition = position;
  globalState.lastUpdatedServerTime = now;
  broadcast("resume", { position, serverTime: now });
  res.json({ success: true });
});

// ── POST /api/seek ─────────────────────────────────────────────────────────────
router.post("/api/seek", (req: Request, res: Response) => {
  const position = Number((req.body as Record<string, unknown>)["position"]) || 0;
  const now = Date.now();
  globalState.lastPosition = position;
  globalState.lastUpdatedServerTime = now;
  broadcast("seek", { position, serverTime: now });
  res.json({ success: true });
});

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
    .map((filename) => ({ filename }));

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

// ── GET /video/:filename ───────────────────────────────────────────────────────
/**
 * HTTP 206 Range streaming.
 * Required for: video seeking in all browsers, Smart TV compatibility,
 * and Chromecast (Cast SDK only uses Range requests).
 */
router.get("/video/:filename", (req: Request, res: Response) => {
  const safeName  = path.basename(req.params["filename"] ?? "");
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
    const [s, e] = rangeHeader.replace(/bytes=/, "").split("-");
    const start  = parseInt(s ?? "0", 10);
    const end    = e ? parseInt(e, 10) : Math.min(start + DEFAULT_CHUNK - 1, fileSize - 1);

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
