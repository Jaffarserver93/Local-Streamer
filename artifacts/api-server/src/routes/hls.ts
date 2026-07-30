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
  status:   HlsStatus;
  hlsDir:   string;
  segments: number;   // segments confirmed on disk so far
  error?:   string;
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

function hlsDir(filename: string): string {
  return path.join(HLS_CACHE_ROOT, stem(filename));
}

/** Count .ts files already on disk for a job dir. */
function countSegments(dir: string): number {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith(".ts")).length;
  } catch { return 0; }
}

/** Kick off ffmpeg HLS segmentation.  Re-entrant: no-op if job already exists. */
function startJob(filename: string, videoPath: string): HlsJob {
  const s = stem(filename);
  const existing = jobs.get(s);
  if (existing) return existing;

  const dir = hlsDir(filename);
  fs.mkdirSync(dir, { recursive: true });

  const job: HlsJob = { status: "generating", hlsDir: dir, segments: 0 };
  jobs.set(s, job);

  const manifestPath = path.join(dir, "index.m3u8");

  const proc = spawn("ffmpeg", [
    "-i",    videoPath,
    "-c",    "copy",                    // no re-encode — fast
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
      broadcast("hls-segment", { filename, count: n });
    }
  }, 500);

  proc.on("close", (code) => {
    clearInterval(watcher);
    const n = countSegments(dir);
    job.segments = n;
    if (code === 0) {
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
router.post("/api/hls/start/:filename", (req: Request, res: Response) => {
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
    res.json({ status: "ready", segments: existing.segments, hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8` });
    return;
  }

  // Cache hit: still generating
  if (existing?.status === "generating") {
    res.json({ status: "generating", segments: existing.segments, hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8` });
    return;
  }

  // Check on-disk cache (server restarted but files remain)
  const manifestPath = path.join(dir, "index.m3u8");
  if (fs.existsSync(manifestPath)) {
    const content = fs.readFileSync(manifestPath, "utf8");
    if (content.includes("#EXT-X-ENDLIST")) {
      const n = countSegments(dir);
      const job: HlsJob = { status: "ready", hlsDir: dir, segments: n };
      jobs.set(s, job);
      res.json({ status: "ready", segments: n, hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8` });
      return;
    }
    // Manifest exists but incomplete — wipe and re-generate
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const job = startJob(filename, videoPath);
  res.json({ status: "generating", segments: job.segments, hlsPath: `/api/hls/${encodeURIComponent(filename)}/index.m3u8` });
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
  res.sendFile(manifestPath);
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
  res.sendFile(segPath);
});

export default router;
