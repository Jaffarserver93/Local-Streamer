/**
 * hls.ts
 *
 * On-demand HLS segmentation for smooth YouTube-like playback.
 *
 * Flow:
 *   1. Client POSTs /api/hls/start/:filename
 *   2. Server spawns: ffmpeg -i <file> -c copy -hls_time 4 ... index.m3u8
 *      Segments land in HLS_CACHE_DIR/<stem>/  (e.g. /tmp/.localstream-hls/<stem>/)
 *   3. As each segment is written, server emits  hls-segment  { filename, count }
 *   4. Client loads /api/hls/:filename/index.m3u8 into Video.js VHS once ≥1 segment exists
 *   5. VHS pre-fetches 3-4 segments ahead — no more stutter
 *   6. When ffmpeg finishes it writes #EXT-X-ENDLIST; server emits  hls-ready
 *   7. VHS reloads manifest → switches to VOD mode → full duration shown
 *
 * Subsequent plays of the same file are instant (cache hit).
 *
 * Routes:
 *   POST /api/hls/start/:filename   — begin (or re-use) HLS generation
 *   GET  /api/hls/:filename/index.m3u8  — serve the live/VOD manifest
 *   GET  /api/hls/:filename/:segment    — serve a .ts segment
 */

import { Router, type Request, type Response } from "express";
import { type Server as IOServer } from "socket.io";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Config ─────────────────────────────────────────────────────────────────────
/** Root cache directory for HLS segments.  Survives restarts but is temp. */
const HLS_CACHE_ROOT =
  process.env["HLS_CACHE_DIR"] ??
  path.join(os.tmpdir(), ".localstream-hls");

/** Seconds per HLS segment.  4 s = YouTube default, good balance of latency vs seeks. */
const HLS_SEGMENT_DURATION = 4;

// ── State ──────────────────────────────────────────────────────────────────────
type HlsStatus = "generating" | "ready" | "error";

interface HlsJob {
  status:      HlsStatus;
  hlsDir:      string;
  segments:    number;   // segments confirmed on disk so far
  transcoding: boolean;  // true = HEVC→H.264 re-encode (slow); false = stream copy (fast)
  error?:      string;
}

/** stem (filename without ext) → job */
const jobs = new Map<string, HlsJob>();

let io: IOServer | null = null;
export function setHlsIO(ioInstance: IOServer): void { io = ioInstance; }

function broadcast(event: string, data: unknown): void { io?.emit(event, data); }

// ── Helpers ────────────────────────────────────────────────────────────────────
function stem(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._\-]/g, "_");
}

/**
 * Browser-native video codecs that can be copied directly into HLS TS segments
 * without re-encoding.  Everything else (HEVC/H.265, AV1, MPEG-2, etc.) needs
 * to be transcoded to H.264 so Chrome/Safari/Firefox can decode it.
 */
const BROWSER_NATIVE_VIDEO_CODECS = new Set([
  "h264", "avc1", "avc",
  "vp8",
  "vp9",
]);

/**
 * Use ffprobe to read the video codec name of the first video stream.
 * Returns the codec name in lower-case, or null if ffprobe isn't available
 * or the file has no video stream.
 */
function probeVideoCodec(videoPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_name",
        "-of", "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ]);
    } catch { resolve(null); return; }

    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => resolve(out.trim().toLowerCase() || null));
    proc.on("error", () => resolve(null));
  });
}

function hlsDir(filename: string): string {
  return path.join(HLS_CACHE_ROOT, stem(filename));
}

/** Count .ts files already on disk for a job dir. */
function countSegments(dir: string): number {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith(".ts")).length;
  } catch { return 0; }
}

/**
 * Version marker written into each HLS cache directory.
 * Bump this string whenever the ffmpeg arguments change (e.g. adding transcode)
 * so that old caches generated with incompatible settings are auto-wiped.
 */
const CACHE_VERSION = "v2-h264-transcode";
const VERSION_FILE  = ".cache_version";

function readCacheVersion(dir: string): string | null {
  try { return fs.readFileSync(path.join(dir, VERSION_FILE), "utf8").trim(); } catch { return null; }
}
function writeCacheVersion(dir: string): void {
  try { fs.writeFileSync(path.join(dir, VERSION_FILE), CACHE_VERSION); } catch {}
}

/** Kick off ffmpeg HLS segmentation.  Re-entrant: no-op if job already exists. */
async function startJob(filename: string, videoPath: string): Promise<HlsJob> {
  const s = stem(filename);
  const existing = jobs.get(s);
  if (existing) return existing;

  const dir = hlsDir(filename);
  fs.mkdirSync(dir, { recursive: true });

  const manifestPath = path.join(dir, "index.m3u8");

  // Detect video codec so we know whether to copy or transcode.
  // HEVC/H.265 (and any unrecognised codec) renders as a black screen in
  // Chrome/Android because MSE doesn't support HEVC in TS segments even when
  // the browser can play HEVC via direct streaming (hardware decoder).
  // Rule: ONLY skip transcode when the codec is explicitly H.264/VP8/VP9.
  // If ffprobe is unavailable (returns null), transcode to be safe.
  const detectedCodec  = await probeVideoCodec(videoPath);
  const needsTranscode = detectedCodec === null || !BROWSER_NATIVE_VIDEO_CODECS.has(detectedCodec);

  const job: HlsJob = { status: "generating", hlsDir: dir, segments: 0, transcoding: needsTranscode };
  jobs.set(s, job);

  const videoArgs: string[] = needsTranscode
    ? [
        // Re-encode to H.264 for browser compatibility.
        // ultrafast preset + scale to 1080p max keeps phones from choking on 4K.
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-vf",  "scale=min(1920\\,iw):min(1080\\,ih):force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:a", "aac", "-b:a", "128k",
      ]
    : ["-c", "copy"];  // stream copy — fast, no quality loss

  const proc = spawn("ffmpeg", [
    "-i",    videoPath,
    ...videoArgs,
    "-f",    "hls",
    "-hls_time",             String(HLS_SEGMENT_DURATION),
    "-hls_list_size",        "0",       // keep all segments in manifest
    "-hls_segment_filename", path.join(dir, "seg%04d.ts"),
    "-hls_flags",            "independent_segments",
    "-y",
    manifestPath,
  ]);

  // Poll every 500 ms for new segments so we can emit socket events
  const watcher = setInterval(() => {
    const n = countSegments(dir);
    if (n > job.segments) {
      job.segments = n;
      broadcast("hls-segment", { filename, count: n, transcoding: job.transcoding });
    }
  }, 500);

  proc.on("close", (code) => {
    clearInterval(watcher);
    const n = countSegments(dir);
    job.segments = n;
    if (code === 0) {
      writeCacheVersion(dir);   // stamp so future restarts know this cache is valid
      job.status = "ready";
      broadcast("hls-ready",   { filename, segments: n });
      broadcast("hls-segment", { filename, count: n });
    } else {
      job.status = "error";
      job.error  = `ffmpeg exited ${code}`;
      broadcast("hls-error", { filename, error: job.error });
      // Clean up partial output so next attempt re-generates
      jobs.delete(s);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  proc.on("error", (e: NodeJS.ErrnoException) => {
    clearInterval(watcher);
    const msg = e.code === "ENOENT"
      ? "ffmpeg not found — install it: pkg install ffmpeg"
      : e.message;
    job.status = "error";
    job.error  = msg;
    broadcast("hls-error", { filename, error: msg });
    jobs.delete(s);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  return job;
}

// ── Router ─────────────────────────────────────────────────────────────────────
const router = Router();

// ── POST /api/hls/start/:filename ──────────────────────────────────────────────
router.post("/api/hls/start/:filename", async (req: Request, res: Response) => {
  const filename  = path.basename(req.params["filename"] ?? "");
  const videoDir  = (req.query["videoDir"] as string | undefined) ?? "";

  if (!filename || !videoDir) {
    res.status(400).json({ error: "filename and videoDir are required" });
    return;
  }

  const videoPath = path.join(videoDir, filename);
  if (!fs.existsSync(videoPath)) {
    res.status(404).json({ error: `Not found: "${filename}"` });
    return;
  }

  const s   = stem(filename);
  const dir = hlsDir(filename);

  // Cache hit: already ready
  const existing = jobs.get(s);
  if (existing?.status === "ready") {
    res.json({ status: "ready", segments: existing.segments, transcoding: false, hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8` });
    return;
  }

  // Cache hit: still generating
  if (existing?.status === "generating") {
    res.json({ status: "generating", segments: existing.segments, transcoding: existing.transcoding, hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8` });
    return;
  }

  // Check on-disk cache (server restarted but files remain).
  // Also verify the cache version — old caches generated without the H.264
  // transcode fix have a different (or missing) version marker and must be wiped.
  const manifestPath = path.join(dir, "index.m3u8");
  if (fs.existsSync(manifestPath)) {
    const cacheVer = readCacheVersion(dir);
    const versionOk = cacheVer === CACHE_VERSION;
    const content   = versionOk ? fs.readFileSync(manifestPath, "utf8") : "";
    if (versionOk && content.includes("#EXT-X-ENDLIST")) {
      const n = countSegments(dir);
      const job: HlsJob = { status: "ready", hlsDir: dir, segments: n, transcoding: false };
      jobs.set(s, job);
      res.json({ status: "ready", segments: n, transcoding: false, hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8` });
      return;
    }
    // Manifest missing version marker (old HEVC cache) or incomplete — wipe and re-generate
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const job = await startJob(filename, videoPath);
  res.json({
    status:      "generating",
    segments:    job.segments,
    transcoding: job.transcoding,
    hlsPath:     `/api/hls/${encodeURIComponent(filename)}/index.m3u8`,
  });
});

// ── POST /api/hls/clear ────────────────────────────────────────────────────────
/** Wipe all HLS segment caches — useful after codec changes or to free space. */
router.post("/api/hls/clear", (_req: Request, res: Response) => {
  jobs.clear();
  try {
    fs.rmSync(HLS_CACHE_ROOT, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/hls/:filename/index.m3u8 ─────────────────────────────────────────
router.get("/api/hls/:filename/index.m3u8", (req: Request, res: Response) => {
  const filename     = path.basename(req.params["filename"] ?? "");
  const dir          = hlsDir(filename);
  const manifestPath = path.join(dir, "index.m3u8");

  if (!fs.existsSync(manifestPath)) {
    res.status(404).json({ error: "HLS not generated yet — POST /api/hls/start/:filename first" });
    return;
  }

  // Use createReadStream instead of res.sendFile — Express 5 sendFile rejects
  // absolute paths without a root option; piping bypasses that entirely.
  res.setHeader("Content-Type",  "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const stream = fs.createReadStream(manifestPath);
  stream.pipe(res);
  stream.on("error", () => { if (!res.headersSent) res.status(500).end(); });
});

// ── GET /api/hls/:filename/:segment ───────────────────────────────────────────
router.get("/api/hls/:filename/:segment", (req: Request, res: Response) => {
  const filename = path.basename(req.params["filename"] ?? "");
  const segment  = path.basename(req.params["segment"]  ?? "");
  const segPath  = path.join(hlsDir(filename), segment);

  if (!fs.existsSync(segPath)) {
    res.status(404).end();
    return;
  }

  // Same fix: pipe directly instead of sendFile
  res.setHeader("Content-Type",  "video/mp2t");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const stream = fs.createReadStream(segPath);
  stream.pipe(res);
  stream.on("error", () => { if (!res.headersSent) res.status(500).end(); });
});

export default router;
