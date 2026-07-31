/**
 * hls.ts
 *
 * On-demand HLS segmentation for smooth YouTube-like playback.
 *
 * Flow:
 *   1. Client POSTs /api/hls/start/:filename
 *   2. Server spawns: ffmpeg [-ss <startAt>] -i <file> -c ... -hls_time 2
 *        -hls_start_number <N> ... index.m3u8
 *      Segments land in HLS_CACHE_DIR/<stem>/  (e.g. /tmp/.localstream-hls/<stem>/)
 *   3. As each segment is written, server emits  hls-segment  { filename, count, startAt }
 *   4. Client switches from direct-stream to HLS once ≥1 segment is ready
 *   5. VHS reads #EXT-X-MEDIA-SEQUENCE:N so it knows segments map to the correct
 *      position in the video timeline — seeking within cached segments is instant.
 *   6. When ffmpeg finishes it writes #EXT-X-ENDLIST; server emits  hls-ready
 *
 * Seek flow (YouTube-like):
 *   Client POSTs /api/hls/seek/:filename  { position }
 *   → server kills current job (if generating), restarts ffmpeg with -ss <seekAt>
 *   → first segment ready in ~1-2 s; server emits hls-segment
 *   → client switches player to HLS at the seek position — instant from that point
 *
 * Subsequent plays of the same file are instant (cache hit).
 *
 * Routes:
 *   POST /api/hls/start/:filename        — begin (or re-use) HLS generation
 *   POST /api/hls/seek/:filename         — restart HLS from a seek position
 *   GET  /api/hls/:filename/index.m3u8  — serve the live/VOD manifest
 *   GET  /api/hls/:filename/:segment     — serve a .ts segment
 *   POST /api/hls/clear                  — wipe all caches
 */

import { Router, type Request, type Response } from "express";
import { type Server as IOServer } from "socket.io";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Config ─────────────────────────────────────────────────────────────────────
const HLS_CACHE_ROOT =
  process.env["HLS_CACHE_DIR"] ??
  path.join(os.tmpdir(), ".localstream-hls");

/** 2 s segments = fine seek granularity; player jumps within a 2-second window. */
const HLS_SEGMENT_DURATION = 2;

// ── State ──────────────────────────────────────────────────────────────────────
type HlsStatus = "generating" | "ready" | "error";

interface HlsJob {
  status:      HlsStatus;
  hlsDir:      string;
  segments:    number;
  transcoding: boolean;
  /** Seconds into the video where this job's segment-0 (or segment-N) starts. */
  startAt:     number;
  /** Socket ID of the client that started this job — events go only to them. */
  socketId:    string;
  /** ffmpeg process — needed so we can kill it on seek restarts. */
  proc?:       ChildProcess;
  /** Segment-count polling interval — cleared when job ends or is killed. */
  watcher?:    ReturnType<typeof setInterval>;
  error?:      string;
}

const jobs = new Map<string, HlsJob>();

let io: IOServer | null = null;
export function setHlsIO(ioInstance: IOServer): void { io = ioInstance; }

/** Emit only to a specific socket (the one that started the HLS job). */
function emitTo(socketId: string, event: string, data: unknown): void {
  if (!socketId) { io?.emit(event, data); return; }
  io?.to(socketId).emit(event, data);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function stem(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._\-]/g, "_");
}

const BROWSER_NATIVE_VIDEO_CODECS = new Set([
  "h264", "avc1", "avc",
  "vp8",
  "vp9",
]);

function probeVideoCodec(videoPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
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

function countSegments(dir: string): number {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith(".ts")).length;
  } catch { return 0; }
}

const CACHE_VERSION = "v2-h264-transcode";
const VERSION_FILE  = ".cache_version";

function readCacheVersion(dir: string): string | null {
  try { return fs.readFileSync(path.join(dir, VERSION_FILE), "utf8").trim(); } catch { return null; }
}
function writeCacheVersion(dir: string): void {
  try { fs.writeFileSync(path.join(dir, VERSION_FILE), CACHE_VERSION); } catch {}
}

/**
 * Kill an in-progress HLS job (process + watcher).
 * Does NOT delete the cache dir — caller is responsible for that.
 */
function killJob(s: string): void {
  const job = jobs.get(s);
  if (!job) return;
  if (job.watcher) { clearInterval(job.watcher); job.watcher = undefined; }
  if (job.proc && job.status === "generating") {
    try { job.proc.kill("SIGKILL"); } catch {}
    job.proc = undefined;
  }
  jobs.delete(s);
}

/**
 * Kick off (or restart) ffmpeg HLS segmentation.
 *
 * @param filename   - original video filename (for the job key + broadcast)
 * @param videoPath  - absolute path to the video file
 * @param startAt    - seconds into the video to begin encoding from (0 = beginning)
 */
async function startJob(filename: string, videoPath: string, startAt = 0, socketId = ""): Promise<HlsJob> {
  const s = stem(filename);

  const dir          = hlsDir(filename);
  const manifestPath = path.join(dir, "index.m3u8");
  fs.mkdirSync(dir, { recursive: true });

  // Detect codec once per file (probing the same file repeatedly is cheap).
  const detectedCodec  = await probeVideoCodec(videoPath);
  const needsTranscode = detectedCodec === null || !BROWSER_NATIVE_VIDEO_CODECS.has(detectedCodec);

  const job: HlsJob = {
    status:      "generating",
    hlsDir:      dir,
    segments:    0,
    transcoding: needsTranscode,
    startAt,
    socketId,
  };
  jobs.set(s, job);

  // Segment numbering: segment N starts at N * HLS_SEGMENT_DURATION in the video.
  // Using -hls_start_number means the manifest sets #EXT-X-MEDIA-SEQUENCE:N so
  // Video.js VHS maps each segment to the correct timeline position automatically.
  const startNumber = Math.floor(startAt / HLS_SEGMENT_DURATION);

  const videoArgs: string[] = needsTranscode
    ? [
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        // Force a keyframe at every segment boundary so seeking always lands immediately
        "-force_key_frames", `expr:gte(t,n_forced*${HLS_SEGMENT_DURATION})`,
        "-vf", "scale=min(1920\\,iw):min(1080\\,ih):force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:a", "aac", "-b:a", "128k",
      ]
    : [
        "-c", "copy",
        // stream-copy mode still benefits from forcing keyframes at segment boundaries
      ];

  const inputArgs: string[] = startAt > 0
    ? ["-ss", String(startAt), "-i", videoPath]  // fast input seek → nearest keyframe
    : ["-i", videoPath];

  const proc = spawn("ffmpeg", [
    ...inputArgs,
    ...videoArgs,
    "-f",                    "hls",
    "-hls_time",             String(HLS_SEGMENT_DURATION),
    "-hls_list_size",        "0",
    "-hls_start_number",     String(startNumber),
    "-hls_segment_filename", path.join(dir, "seg%04d.ts"),
    "-hls_flags",            "independent_segments",
    "-y",
    manifestPath,
  ]);

  job.proc = proc;

  // Poll every 500 ms for new .ts files
  const watcher = setInterval(() => {
    const n = countSegments(dir);
    if (n > job.segments) {
      job.segments = n;
      emitTo(job.socketId, "hls-segment", { filename, count: n, transcoding: job.transcoding, startAt });
    }
  }, 500);

  job.watcher = watcher;

  proc.on("close", (code) => {
    clearInterval(watcher);
    job.watcher = undefined;
    // Only handle if this job is still the active one (not killed by a seek restart)
    if (jobs.get(s) !== job) return;
    const n = countSegments(dir);
    job.segments = n;
    if (code === 0) {
      // Only mark "ready" when the job covered the full video (startAt === 0).
      // A seek-started job only covers startAt→end; the player handles it but
      // we don't want to permanently mark the cache as complete.
      if (startAt === 0) {
        writeCacheVersion(dir);
        job.status = "ready";
        emitTo(job.socketId, "hls-ready", { filename, segments: n });
      } else {
        // Mark as a completed seek job so we stop polling but don't label full-cache
        job.status = "ready";
        emitTo(job.socketId, "hls-seek-ready", { filename, segments: n, startAt });
      }
      emitTo(job.socketId, "hls-segment", { filename, count: n, transcoding: false, startAt });
    } else {
      job.status = "error";
      job.error  = `ffmpeg exited ${code}`;
      emitTo(job.socketId, "hls-error", { filename, error: job.error });
      jobs.delete(s);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  proc.on("error", (e: NodeJS.ErrnoException) => {
    clearInterval(watcher);
    job.watcher = undefined;
    if (jobs.get(s) !== job) return;
    const msg = e.code === "ENOENT"
      ? "ffmpeg not found — install it: pkg install ffmpeg"
      : e.message;
    job.status = "error";
    job.error  = msg;
    emitTo(job.socketId, "hls-error", { filename, error: msg });
    jobs.delete(s);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  return job;
}

// ── Router ─────────────────────────────────────────────────────────────────────
const router = Router();

// ── POST /api/hls/start/:filename ──────────────────────────────────────────────
router.post("/api/hls/start/:filename", async (req: Request, res: Response) => {
  const filename = path.basename(req.params["filename"] ?? "");
  const videoDir = (req.query["videoDir"] as string | undefined) ?? "";
  const socketId = (req.query["socketId"] as string | undefined) ?? "";

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

  // Cache hit: already fully ready (started from beginning)
  const existing = jobs.get(s);
  if (existing?.status === "ready" && existing.startAt === 0) {
    res.json({ status: "ready", segments: existing.segments, transcoding: false, startAt: 0, hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8` });
    return;
  }

  // Cache hit: still generating from beginning
  if (existing?.status === "generating") {
    res.json({ status: "generating", segments: existing.segments, transcoding: existing.transcoding, startAt: existing.startAt, hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8` });
    return;
  }

  // On-disk cache check (server restarted but files remain)
  const manifestPath = path.join(dir, "index.m3u8");
  if (fs.existsSync(manifestPath)) {
    const cacheVer = readCacheVersion(dir);
    const versionOk = cacheVer === CACHE_VERSION;
    const content   = versionOk ? fs.readFileSync(manifestPath, "utf8") : "";
    if (versionOk && content.includes("#EXT-X-ENDLIST")) {
      const n = countSegments(dir);
      const job: HlsJob = { status: "ready", hlsDir: dir, segments: n, transcoding: false, startAt: 0, socketId };
      jobs.set(s, job);
      res.json({ status: "ready", segments: n, transcoding: false, startAt: 0, hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8` });
      return;
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const job = await startJob(filename, videoPath, 0, socketId);
  res.json({
    status:      "generating",
    segments:    job.segments,
    transcoding: job.transcoding,
    startAt:     0,
    hlsPath:     `/api/hls/${encodeURIComponent(filename)}/index.m3u8`,
  });
});

// ── POST /api/hls/seek/:filename ───────────────────────────────────────────────
/**
 * YouTube-like seek: restart HLS generation from a specific position.
 *
 * Kills any in-progress ffmpeg job for this file, wipes the cache dir,
 * and restarts ffmpeg with  -ss <seekAt>  and  -hls_start_number <N>
 * so segments land on the correct timeline position without any offset tricks.
 *
 * Body: { position: number }  (seconds in the video)
 *
 * The client receives the normal hls-segment socket events.
 * Once 1 segment is ready (~1-2 s), the client can switch to HLS at
 * player.currentTime(position) and get instant playback.
 *
 * If the job is already fully ready (full-file cache from start), returns
 * { status: "ready" } — client should just seek within existing HLS.
 */
router.post("/api/hls/seek/:filename", async (req: Request, res: Response) => {
  const filename = path.basename(req.params["filename"] ?? "");
  const videoDir = (req.query["videoDir"] as string | undefined) ?? "";
  const socketId = (req.query["socketId"] as string | undefined) ?? "";
  const position = Number((req.body as Record<string, unknown>)?.["position"]) || 0;

  if (!filename || !videoDir) {
    res.status(400).json({ error: "filename and videoDir are required" });
    return;
  }

  const s       = stem(filename);
  const existing = jobs.get(s);

  // Full-file cache already done — player can seek natively in the HLS manifest
  if (existing?.status === "ready" && existing.startAt === 0) {
    res.json({ status: "ready", seekAt: 0, hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8` });
    return;
  }

  // If seeking within the already-generating region, don't restart
  if (existing?.status === "generating") {
    const coveredUntil = existing.startAt + existing.segments * HLS_SEGMENT_DURATION;
    if (position >= existing.startAt && position <= coveredUntil + HLS_SEGMENT_DURATION) {
      // Target is already on disk or will be within the next segment
      res.json({
        status:  "generating",
        seekAt:  existing.startAt,
        hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8`,
      });
      return;
    }
  }

  // Snap to nearest segment boundary at or before the requested position
  const seekAt = Math.floor(position / HLS_SEGMENT_DURATION) * HLS_SEGMENT_DURATION;

  // Kill current job (if any) and wipe cache so new job starts clean
  killJob(s);
  const dir = hlsDir(filename);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  const videoPath = path.join(videoDir, filename);
  if (!fs.existsSync(videoPath)) {
    res.status(404).json({ error: `Not found: "${filename}"` });
    return;
  }

  const job = await startJob(filename, videoPath, seekAt, socketId);

  res.json({
    status:      "started",
    seekAt,
    transcoding: job.transcoding,
    hlsPath:     `/api/hls/${encodeURIComponent(filename)}/index.m3u8`,
  });
});

// ── POST /api/hls/clear ────────────────────────────────────────────────────────
router.post("/api/hls/clear", (_req: Request, res: Response) => {
  // Kill any running jobs first
  for (const s of jobs.keys()) killJob(s);
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

  res.setHeader("Content-Type",  "video/mp2t");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const stream = fs.createReadStream(segPath);
  stream.pipe(res);
  stream.on("error", () => { if (!res.headersSent) res.status(500).end(); });
});

export default router;
