/**
 * videos.ts
 *
 * Routes:
 *   GET  /events              — SSE stream; all clients subscribe here
 *   POST /api/play            — broadcast "play <filename>" to ALL connected clients instantly
 *   GET  /api/videos          — list video files in currentVideoDir
 *   GET  /api/video-dir       — return currentVideoDir path
 *   POST /api/set-video-dir   — change currentVideoDir at runtime
 *   GET  /video/:filename     — HTTP 206 Range streaming
 */

import { Router, type IRouter, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * VIDEO_DIR — folder the server reads & writes video files from/to.
 * Change at runtime via POST /api/set-video-dir.
 *
 *   VIDEO_DIR=/sdcard/Download node dist/index.mjs   # Android
 *   VIDEO_DIR=/Volumes/USB/Movies node dist/index.mjs # macOS external drive
 */
let currentVideoDir: string =
  process.env["VIDEO_DIR"] ?? path.join(__dirname, "..", "videos");

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
};
const SUPPORTED_EXTS = new Set(Object.keys(MIME_TYPES));
const DEFAULT_CHUNK = 1024 * 1024; // 1 MB

const STREAM_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers":
    "Content-Range, Accept-Ranges, Content-Length, Content-Type",
};

// ─── SSE client registry ──────────────────────────────────────────────────────
/** Every connected browser tab (TV and phone) gets one Response entry here */
const sseClients = new Set<Response>();

/**
 * Push an event to ALL connected clients simultaneously.
 * This is how the phone triggers playback on the TV.
 */
function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      // Client disconnected; remove silently
      sseClients.delete(client);
    }
  }
}

const router: IRouter = Router();

// ─── GET /events ─────────────────────────────────────────────────────────────
/**
 * Server-Sent Events stream.
 *
 * Both the TV and the phone subscribe here on page load.
 * When the phone uploads a file or taps "Play on TV", the server broadcasts
 * a "play" event and every connected screen receives it instantly.
 *
 * EventSource auto-reconnects natively (no client-side retry logic needed).
 */
router.get("/events", (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx/proxy buffering
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Type",
  });

  // Tell the browser to reconnect after 3 s if the connection drops
  res.write("retry: 3000\n\n");
  res.write(":connected\n\n"); // comment line — keeps the connection alive immediately

  sseClients.add(res);

  // Heartbeat every 25 s — prevents proxies from closing idle connections
  const heartbeat = setInterval(() => {
    try {
      res.write(":heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// ─── POST /api/play ───────────────────────────────────────────────────────────
/**
 * Remote-control endpoint: phone taps "▶ Play on TV" next to a library card
 * and the server broadcasts a "play" event to ALL connected screens.
 * No file transfer happens here — just a play command for an existing server file.
 */
router.post("/api/play", (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const filename = body["filename"];

  if (!filename || typeof filename !== "string") {
    res.status(400).json({ error: "Body must contain { filename: string }" });
    return;
  }

  broadcast("play", { filename });
  res.json({ success: true, clients: sseClients.size });
});

// ─── GET /api/video-dir ───────────────────────────────────────────────────────
router.get("/api/video-dir", (_req: Request, res: Response) => {
  res.json({ path: currentVideoDir });
});

// ─── POST /api/set-video-dir ──────────────────────────────────────────────────
router.post("/api/set-video-dir", (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
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

// ─── GET /api/videos ─────────────────────────────────────────────────────────
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

// ─── GET /video/:filename ─────────────────────────────────────────────────────
/**
 * HTTP 206 Range streaming. Required for:
 *   • Video seeking in all browsers
 *   • Smart TV compatibility
 *   • Chromecast (Cast SDK only uses Range requests)
 */
router.get("/video/:filename", (req: Request, res: Response) => {
  const safeName = path.basename(req.params["filename"] ?? "");
  const videoPath = path.join(currentVideoDir, safeName);
  const ext = path.extname(safeName).toLowerCase();

  if (!SUPPORTED_EXTS.has(ext)) {
    res.status(400).json({ error: `Unsupported type "${ext}".` });
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
