# Local Stream

A self-hosted video streaming server. Point it at a folder of videos, open the URL on any device on the same Wi-Fi, and stream or send videos to your TV.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + start the API server (uses `PORT` env var)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- Required env: `PORT` — port number the server listens on (Replit sets this automatically)
- Optional env: `VIDEO_DIR` — folder to serve videos from (default: `artifacts/api-server/videos/`)

## Stack

- pnpm workspaces, Node.js 20, TypeScript 5.9
- API: Express 5
- Video: HTTP 206 Range streaming, Video.js v8, Socket.io for real-time sync
- Build: esbuild (ESM bundle → `artifacts/api-server/dist/index.mjs`)

## Running on Termux (Android)

The built server (`dist/index.mjs`) runs standalone — no pnpm needed at runtime.

**Step 1 — Build on Replit** (one time):
```
pnpm --filter @workspace/api-server run build
```

**Step 2 — Copy to your Android device**:
Copy the `artifacts/api-server/dist/` folder and the `artifacts/api-server/public/` folder to your device (e.g. `/sdcard/LocalStream/`).

**Step 3 — Install Node.js in Termux**:
```
pkg update && pkg install nodejs
```

**Step 4 — Run the server**:
```
PORT=3000 VIDEO_DIR=/sdcard/Download node /sdcard/LocalStream/dist/index.mjs
```

**Step 5 — Open in browser**:
Open `http://127.0.0.1:3000` on the same device, or `http://<your-phone-IP>:3000` from any other device on the same Wi-Fi.

> **Tip:** Find your phone's IP with `ip addr show wlan0 | grep inet` in Termux.

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
