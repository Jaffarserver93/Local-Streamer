/**
 * index.ts
 * Server entry point.
 *
 * Listens on PORT (default 3000) for BOTH plain HTTP and HTTPS on the same port.
 * A TCP-level detector reads the first byte:
 *   - 0x16 = TLS ClientHello  → route to the HTTPS handler
 *   - anything else           → route to the plain HTTP handler
 *
 * This lets Smart TVs that auto-upgrade to https:// reach the same server that
 * phones use with http://, with no port change required.
 *
 * A self-signed TLS certificate is generated with openssl on first run and
 * cached in ~/.localstream-certs/ for subsequent starts.  The TV browser will
 * show a "not secure" warning once — tap "Advanced → Proceed" to continue.
 */

import net                     from "node:net";
import http                    from "node:http";
import https                   from "node:https";
import { execSync }             from "node:child_process";
import fs                       from "node:fs";
import path                     from "node:path";
import os                       from "node:os";
import { Server }               from "socket.io";
import app                      from "./app.js";
import { setIO, getGlobalState, livePosition } from "./routes/videos.js";
import { setHlsIO }             from "./routes/hls.js";
import { logger, logFile }      from "./lib/logger.js";

// ── Config ─────────────────────────────────────────────────────────────────────
const rawPort = process.env["PORT"] ?? "3000";
const port    = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── TLS certificate ────────────────────────────────────────────────────────────
const CERT_DIR  = path.join(os.homedir(), ".localstream-certs");
const CERT_FILE = path.join(CERT_DIR, "cert.pem");
const KEY_FILE  = path.join(CERT_DIR, "key.pem");

function generateCert(): { key: string; cert: string } | null {
  try {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}"` +
      ` -days 3650 -nodes -subj "/CN=localstream"`,
      { stdio: "pipe" },
    );
    return {
      key:  fs.readFileSync(KEY_FILE,  "utf8"),
      cert: fs.readFileSync(CERT_FILE, "utf8"),
    };
  } catch (e) {
    logger.warn({ err: e }, "openssl not available — HTTPS disabled. Install it: pkg install openssl-tool");
    return null;
  }
}

function loadOrGenerateCert(): { key: string; cert: string } | null {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    try {
      return {
        key:  fs.readFileSync(KEY_FILE,  "utf8"),
        cert: fs.readFileSync(CERT_FILE, "utf8"),
      };
    } catch { /* fall through to regenerate */ }
  }
  return generateCert();
}

const tlsCredentials = loadOrGenerateCert();

// ── HTTP + HTTPS servers ───────────────────────────────────────────────────────
const httpServer  = http.createServer(app);
const httpsServer = tlsCredentials
  ? https.createServer(tlsCredentials, app)
  : null;

// ── Socket.io ─────────────────────────────────────────────────────────────────
// Attach io to the HTTP server.  HTTPS WebSocket upgrades are forwarded to
// the same io engine so all clients — HTTP and HTTPS — share one room.
const io = new Server(httpServer, {
  cors:       { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

if (httpsServer) {
  // Forward WebSocket upgrades from the HTTPS server to the same io engine
  httpsServer.on("upgrade", (req, socket, head) => {
    io.engine.handleUpgrade(req, socket as import("node:stream").Duplex, head);
  });
}

setIO(io);
setHlsIO(io);

// ── Socket.io connection handler ───────────────────────────────────────────────
io.on("connection", (socket) => {
  socket.on("ping-sync", (clientTime: number) => {
    socket.emit("pong-sync", { clientTime, serverTime: Date.now() });
  });

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

// ── TCP multiplexer — HTTP and HTTPS on the same port ─────────────────────────
/**
 * Read the very first byte of each incoming TCP connection.
 * TLS ClientHello always starts with 0x16 (decimal 22).
 * Everything else is treated as plain HTTP.
 */
const tcpServer = net.createServer((socket) => {
  socket.once("data", (firstChunk) => {
    socket.pause();

    const isTls = firstChunk[0] === 0x16;
    const target = (isTls && httpsServer) ? httpsServer : httpServer;

    // Push the already-read bytes back so the target server sees a complete request
    socket.unshift(firstChunk);
    target.emit("connection", socket);

    socket.resume();
  });

  socket.on("error", () => { /* ignore aborted connections */ });
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
tcpServer.listen(port, "0.0.0.0", () => {
  const localIP  = getLocalIPv4();
  const hasHttps = !!httpsServer;

  logger.info({ port }, "Server listening on all interfaces");
  logger.info(`  📄  Log file: ${logFile}`);

  if (localIP) {
    const httpUrl  = `http://${localIP}:${port}`;
    const httpsUrl = `https://${localIP}:${port}`;
    logger.info(
      `\n\n  📺  Smart TV (Samsung/LG):\n\n       ${hasHttps ? httpsUrl : httpUrl}` +
      (hasHttps ? `  ← accept the "not secure" warning once` : "") +
      `\n\n  📱  Phone / tablet:\n\n       ${httpUrl}\n`,
    );
  } else {
    logger.warn(
      "Could not detect a local network IP. " +
      "Find it with `ip addr show wlan0` (Android/Linux) / `ipconfig` (Windows).",
    );
  }

  logger.info(`  💻  Localhost: http://localhost:${port}`);
});
