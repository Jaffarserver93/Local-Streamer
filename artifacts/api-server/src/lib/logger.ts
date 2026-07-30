import pino from "pino";
import fs from "node:fs";
import path from "node:path";

const isProduction = process.env.NODE_ENV === "production";

// Log file path — override with LOG_FILE env var.
// Default: api.log inside VIDEO_DIR (same folder as the videos),
// falling back to the working directory if VIDEO_DIR isn't set.
export const logFile = path.resolve(
  process.env["LOG_FILE"] ??
    path.join(process.env["VIDEO_DIR"] ?? process.cwd(), "api.log")
);

// Try to create the log file's parent dir and do a write-test.
// If the path isn't writable (e.g. Android storage permission denied),
// fall back to stdout-only so the server still starts.
let fileWritable = false;
try {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, ""); // write-test — creates file if missing
  fileWritable = true;
} catch (e) {
  process.stderr.write(
    `[logger] WARNING: cannot write to log file "${logFile}": ${(e as Error).message}\n` +
    `[logger] Falling back to stdout-only logging.\n`
  );
}

const targets: pino.TransportTargetOptions[] = [
  // Console: pretty in dev, plain JSON in production
  ...(isProduction
    ? [{ target: "pino/file", options: { destination: 1 }, level: process.env["LOG_LEVEL"] ?? "info" }]
    : [{ target: "pino-pretty", options: { colorize: true }, level: process.env["LOG_LEVEL"] ?? "info" }]
  ),
  // File — only if writable
  ...(fileWritable
    ? [{ target: "pino/file", options: { destination: logFile, append: true }, level: process.env["LOG_LEVEL"] ?? "info" }]
    : []
  ),
];

const transport = pino.transport({ targets });

export const logger = pino(
  {
    level: process.env["LOG_LEVEL"] ?? "info",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
    ],
  },
  transport
);
