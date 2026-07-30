import pino from "pino";
import fs from "node:fs";
import path from "node:path";

const isProduction = process.env.NODE_ENV === "production";

// Log file path — override with LOG_FILE env var, default next to the dist/
const logFile = path.resolve(
  process.env["LOG_FILE"] ?? path.join(process.cwd(), "api.log")
);

// Ensure the log file's parent directory exists
fs.mkdirSync(path.dirname(logFile), { recursive: true });

const transport = pino.transport({
  targets: [
    // Always write JSON lines to the log file (appends on restart)
    {
      target: "pino/file",
      options: { destination: logFile, append: true },
      level: process.env["LOG_LEVEL"] ?? "info",
    },
    // Console output — pretty in dev, plain JSON in production
    ...(isProduction
      ? [
          {
            target: "pino/file",
            options: { destination: 1 /* stdout */ },
            level: process.env["LOG_LEVEL"] ?? "info",
          },
        ]
      : [
          {
            target: "pino-pretty",
            options: { colorize: true },
            level: process.env["LOG_LEVEL"] ?? "info",
          },
        ]),
  ],
});

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
