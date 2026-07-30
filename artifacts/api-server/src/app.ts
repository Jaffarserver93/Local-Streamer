/**
 * app.ts
 * Configures and exports the Express application.
 * 
 * Middleware order:
 *   1. Request logging (pino-http)
 *   2. CORS — must be early so OPTIONS preflight and Cast requests are allowed
 *   3. Body parsers
 *   4. Static files from public/  (serves index.html, style.css, script.js)
 *   5. Video routes  (/api/videos  and  /video/:filename)
 *   6. API router    (/api/healthz, etc.)
 */

import express, { type Express } from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import pinoHttp from "pino-http";
import router from "./routes";
import videosRouter from "./routes/videos";
import { logger } from "./lib/logger";

// Resolve __dirname in ESM context
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the public/ folder that contains the frontend HTML, CSS, and JS.
 * In development and production, this folder lives next to the `dist/` output:
 *   artifacts/api-server/
 *     dist/index.mjs   ← __dirname points here at runtime
 *     public/          ← one level up
 */
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const app: Express = express();

// ── Logging ───────────────────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          // Strip query strings from logged URLs for privacy
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow all origins so that:
//   • Smart TVs on the same Wi-Fi can fetch /api/videos
//   • Chromecast (which runs in a sandboxed iframe) can stream /video/:filename
app.use(cors({ exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"] }));

// ── Body Parsers ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Static Files ──────────────────────────────────────────────────────────────
// Serve index.html, style.css, script.js from the public/ folder.
// This makes the UI available at the root URL (e.g. http://192.168.1.x:3000/).
app.use(express.static(PUBLIC_DIR));

// ── Video Routes ──────────────────────────────────────────────────────────────
// Handles:
//   GET /api/videos         → list available video files
//   GET /video/:filename    → stream a video (HTTP Range / 206 Partial Content)
app.use(videosRouter);

// ── API Router ────────────────────────────────────────────────────────────────
// Health check and other API endpoints mounted at /api
app.use("/api", router);

export default app;
