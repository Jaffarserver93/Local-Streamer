/**
 * index.ts
 * Server entry point.
 * 
 * Starts the Express server and logs:
 *   • The local network URL (for connecting Smart TVs / Chromecast)
 *   • The localhost URL (for local browser testing)
 */

import os from "node:os";
import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Finds the machine's local IPv4 address on the LAN (e.g. 192.168.1.42).
 * 
 * How it works:
 *   • Iterates all network interfaces (Wi-Fi, Ethernet, etc.)
 *   • Skips loopback (127.x.x.x) and IPv6 addresses
 *   • Returns the first external IPv4 it finds
 * 
 * Returns undefined if no suitable interface is found (e.g. no Wi-Fi connected).
 */
function getLocalIPv4(): string | undefined {
  const interfaces = os.networkInterfaces();

  for (const ifaceName of Object.keys(interfaces)) {
    const addresses = interfaces[ifaceName];
    if (!addresses) continue;

    for (const addr of addresses) {
      // We want an external (non-loopback), IPv4 address
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }

  return undefined;
}

// ── Bind to 0.0.0.0 so ALL network interfaces can reach the server ────────────
// Binding to 127.0.0.1 (default) would make it localhost-only.
// Binding to 0.0.0.0 makes it reachable on your local Wi-Fi network,
// which is required for Smart TVs and Chromecast to connect.
app.listen(port, "0.0.0.0", (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error starting server");
    process.exit(1);
  }

  const localIP = getLocalIPv4();

  logger.info({ port }, "Server listening on all interfaces");

  // ── TV / Chromecast access URL ────────────────────────────────────────
  if (localIP) {
    logger.info(
      `\n\n  📺  Play on your Smart TV by visiting:\n\n       http://${localIP}:${port}\n\n  📱  Or open on your phone to use Chromecast:\n\n       http://${localIP}:${port}\n`,
    );
  } else {
    logger.warn(
      "Could not detect a local network IP. Make sure you are connected to Wi-Fi. " +
        "Find your IP with `ip addr` (Linux) or `ipconfig` (Windows) or `ifconfig` (macOS).",
    );
  }

  logger.info(`  💻  Localhost access: http://localhost:${port}`);
});
