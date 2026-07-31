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

/**
 * Whether this FFmpeg build requires compat mode (detected on first exit-8).
 * In compat mode we drop options that some stripped FFmpeg builds (e.g. Termux)
 * don't recognise: currently `-hls_start_number`.
 * Once set, all subsequent spawns skip the unsupported flags immediately.
 */
let ffmpegCompatMode = false;

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
  // When supported, -hls_start_number sets #EXT-X-MEDIA-SEQUENCE:N so Video.js VHS
  // maps each segment to the correct timeline position automatically.
  // Some stripped FFmpeg builds (e.g. Termux) don't recognise this option and exit
  // with code 8 (AVERROR_OPTION_NOT_FOUND) — we detect that and retry without it.
  const startNumber = Math.floor(startAt / HLS_SEGMENT_DURATION);

  const videoArgs: string[] = needsTranscode
    ? [
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:a", "aac", "-b:a", "128k",
      ]
    : [
        "-c", "copy",
      ];

  const inputArgs: string[] = startAt > 0
    ? ["-ss", String(startAt), "-i", videoPath]  // fast input seek → nearest keyframe
    : ["-i", videoPath];

  /**
   * Build the ffmpeg arg list.
   * compat=true  → omit options that some stripped builds don't support
   *                (currently: -hls_start_number, -hls_flags independent_segments)
   * compat=false → full option set for well-equipped builds
   */
  function buildArgs(compat: boolean): string[] {
    return [
      ...inputArgs,
      ...videoArgs,
      "-f",                    "hls",
      "-hls_time",             String(HLS_SEGMENT_DURATION),
      "-hls_list_size",        "0",
      // -hls_start_number is absent from some FFmpeg builds; dropped in compat mode.
      ...(compat ? [] : ["-hls_start_number", String(startNumber)]),
      "-hls_segment_filename", path.join(dir, "seg%04d.ts"),
      // -hls_flags independent_segments is omitted entirely — Termux's FFmpeg
      // doesn't recognise it and exits with code 8. It's cosmetic for VOD.
      "-y",
      manifestPath,
    ];
  }

  /** Spawn ffmpeg and resolve once it exits. Returns { code, stderr }. */
  function spawnFfmpeg(args: string[]): { proc: ChildProcess; done: Promise<{ code: number | null; stderr: string }> } {
    const proc = spawn("ffmpeg", args);
    let stderrBuf = "";
    proc.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
    const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      proc.on("close", (code) => resolve({ code, stderr: stderrBuf }));
      proc.on("error",  (e: NodeJS.ErrnoException) => {
        const msg = e.code === "ENOENT"
          ? "ffmpeg not found — install it: pkg install ffmpeg"
          : e.message;
        resolve({ code: -1, stderr: msg });
      });
    });
    return { proc, done };
  }

  // ── First attempt ─────────────────────────────────────────────────────────────
  const attempt1 = spawnFfmpeg(buildArgs(ffmpegCompatMode));
  job.proc = attempt1.proc;

  // Poll every 500 ms for new .ts files
  const watcher = setInterval(() => {
    const n = countSegments(dir);
    if (n > job.segments) {
      job.segments = n;
      emitTo(job.socketId, "hls-segment", { filename, count: n, transcoding: job.transcoding, startAt });
    }
  }, 500);

  job.watcher = watcher;

  // ── Handle result (with optional compat retry on exit 8) ──────────────────────
  void attempt1.done.then(async ({ code, stderr }) => {
    // Guard: ignore if a seek restart killed this job
    if (jobs.get(s) !== job) return;

    // ── Exit 8 = AVERROR_OPTION_NOT_FOUND → enable compat mode and retry ─────
    if (code === 8 && !ffmpegCompatMode) {
      // Log the full stderr so the exact option name is visible in the log
      console.error(
        `[HLS] FFmpeg exited 8 (option not found) for "${filename}". Full stderr:\n${stderr.trim()}\n` +
        `[HLS] Switching to compat mode (dropping -hls_start_number) and retrying.`,
      );
      ffmpegCompatMode = true;

      // Wipe the (empty) cache dir and restart with compat args
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(dir, { recursive: true });

      const attempt2 = spawnFfmpeg(buildArgs(true));
      job.proc = attempt2.proc;

      const { code: code2, stderr: stderr2 } = await attempt2.done;
      if (jobs.get(s) !== job) return;
      handleClose(code2, stderr2);
      return;
    }

    handleClose(code, stderr);
  });

  function handleClose(code: number | null, stderr: string): void {
    clearInterval(watcher);
    job.watcher = undefined;
    if (jobs.get(s) !== job) return;

    const n = countSegments(dir);
    job.segments = n;

    if (code === 0) {
      if (startAt === 0) {
        writeCacheVersion(dir);
        job.status = "ready";
        emitTo(job.socketId, "hls-ready", { filename, segments: n });
      } else {
        job.status = "ready";
        emitTo(job.socketId, "hls-seek-ready", { filename, segments: n, startAt });
      }
      emitTo(job.socketId, "hls-segment", { filename, count: n, transcoding: false, startAt });
    } else {
      // Log the full stderr so the failing option name is visible
      const lastLine  = stderr.trim().split("\n").pop() || `exit code ${code}`;
      const fullDiag  = stderr.trim().length > lastLine.length
        ? `\n--- ffmpeg stderr ---\n${stderr.trim()}\n---`
        : "";
      console.error(`[HLS Error] FFmpeg failed for "${filename}" (exit ${code}): ${lastLine}${fullDiag}`);
      job.status = "error";
      job.error  = `ffmpeg exited ${code}: ${lastLine}`;
      emitTo(job.socketId, "hls-error", { filename, error: job.error });
      jobs.delete(s);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  return job;
}

// ── Router ─────────────────────────────────────────────────────────────────────
const router = Router();

// ── POST /api/hls/start/:filename ──────────────────────────────────────────────
router.post("/api/hls/start/:filename", async (req: Request, res: Response) => {
  const filename = path.basename(String(req.params["filename"] || ""));
  const videoDir = String(req.query["videoDir"] || "");
  const socketId = String(req.query["socketId"] || "");

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
  const filename = path.basename(String(req.params["filename"] || ""));
  const videoDir = String(req.query["videoDir"] || "");
  const socketId = String(req.query["socketId"] || "");
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
  const filename     = path.basename(String(req.params["filename"] || ""));
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
  const filename = path.basename(String(req.params["filename"] || ""));
  const segment  = path.basename(String(req.params["segment"] || ""));
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
