/**
 * index.ts
 * Server entry point.
 *
 * Creates an HTTP server, attaches Socket.io, and starts listening.
 * Socket.io is used instead of SSE for sub-50ms bidirectional sync:
 *   - NTP-style clock offset negotiation on every connection
 *   - Instant play/pause/seek broadcasts to all connected clients
 *   - Late-joiner catch-up: new tabs receive current playback state on connect
 */

import { createServer } from "node:http";
import { Server } from "socket.io";
import os from "node:os";
import app from "./app.js";
import { setIO, getGlobalState, livePosition } from "./routes/videos.js";
import { logger } from "./lib/logger.js";

const rawPort = process.env["PORT"] ?? "3000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── HTTP server + Socket.io ────────────────────────────────────────────────────
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  // Prefer WebSocket; fall back to long-polling for proxied enviroments
  transports: ["websocket", "polling"],
});

// Give the videos router a reference to the Socket.io server so it can broadcast
setIO(io);

// ── Socket.io connection handler ───────────────────────────────────────────────
io.on("connection", (socket) => {
  // NTP-style clock sync: client sends its local timestamp, server echoes it
  // back with its own. Client calculates round-trip latency and clock offset.
  // Runs once on connect; client may repeat every 30 s to stay accurate.
  socket.on("ping-sync", (clientTime: number) => {
    socket.emit("pong-sync", { clientTime, serverTime: Date.now() });
  });

  // ── Late-joiner catch-up ────────────────────────────────────────────────────
  // When a new tab/device opens, send it the current playback state so it
  // jumps straight to the right video and position.
  const state = getGlobalState();
  if (state.currentVideo) {
    socket.emit("play", {
      filename:   state.currentVideo,
      position:   livePosition(),
      serverTime: Date.now(),
      paused:     !state.isPlaying,
    });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function getLocalIPv4(): string | undefined {
  const interfaces = os.networkInterfaces();
  for (const ifaceName of Object.keys(interfaces)) {
    const addresses = interfaces[ifaceName];
    if (!addresses) continue;
    for (const addr of addresses) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

// ── Start listening ────────────────────────────────────────────────────────────
// Bind to 0.0.0.0 so Smart TVs and phones on the same Wi-Fi can reach the server
httpServer.listen(port, "0.0.0.0", () => {
  const localIP = getLocalIPv4();

  logger.info({ port }, "Server listening on all interfaces");

  if (localIP) {
    logger.info(
      `\n\n  📺  Play on your Smart TV:\n\n       http://${localIP}:${port}\n\n` +
      `  📱  Open on your phone:\n\n       http://${localIP}:${port}\n`,
    );
  } else {
    logger.warn(
      "Could not detect a local network IP. " +
      "Find it with `ip addr` (Linux) / `ipconfig` (Windows) / `ifconfig` (macOS).",
    );
  }

  logger.info(`  💻  Localhost: http://localhost:${port}`);
});
