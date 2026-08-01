import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Log file path — override with LOG_FILE env var.
export const logFile = path.resolve(
  process.env["LOG_FILE"] ??
    path.join(__dirname, "..", "..", "api.log")
);

let fileStream: fs.WriteStream | null = null;
try {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fileStream = fs.createWriteStream(logFile, { flags: "a" });
} catch (e) {
  process.stderr.write(
    `[logger] WARNING: cannot write to log file "${logFile}": ${(e as Error).message}\n` +
    `[logger] Falling back to stdout-only logging.\n`
  );
}

// In-process streams (stdout + fileStream) — avoids worker_threads path resolution issues on Android/Termux
const streams: pino.DestinationStream[] = [
  process.stdout,
  ...(fileStream ? [fileStream] : []),
];

export const logger = pino(
  {
    level: process.env["LOG_LEVEL"] ?? "info",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
    ],
  },
  pino.multistream(streams)
);
