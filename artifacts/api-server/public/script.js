/**
 * script.js — Local Stream
 *
 * ─── How synchronized playback works ─────────────────────────────────────────
 *
 *   Any device on the page automatically joins the single global session.
 *   When ANY user taps a video or hits play/pause/seek, that action is
 *   broadcast via Socket.io to every connected device simultaneously.
 *
 *   CLOCK SYNC (NTP-style)
 *   ──────────────────────
 *   On connect (and every 30 s), the client sends a ping-sync with its local
 *   timestamp. The server echoes it back with its own timestamp. The client
 *   calculates round-trip latency and derives a clock offset so that when the
 *   server says "position=42.3 at serverTime=T", the client can compute the
 *   live position as: 42.3 + (serverNow() - T) / 1000  — accurate to <50 ms.
 *
 *   PHONE → SERVER → ALL SCREENS
 *   ─────────────────────────────
 *   Tap video card  →  POST /api/play  →  socket.emit("play", ...)  →  all clients
 *   Tap pause       →  POST /api/pause →  socket.emit("pause", ...) →  all clients
 *   Seek scrubber   →  POST /api/seek  →  socket.emit("seek", ...)  →  all clients
 *
 * Sections:
 *   §1  Clock sync
 *   §2  Video.js player
 *   §3  Socket.io sync listener
 *   §4  Double-tap ±5 s seek
 *   §5  Keyboard / TV remote
 *   §6  Video library
 *   §7  Upload (Add to library)
 *   §8  Folder picker
 *   §9  Playback router
 *   §10 Boot
 */

/* ═══════════════════════════════════════════════════════════════════════════
   §1  Clock sync  (NTP-style offset calculation)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Estimated offset in ms between our clock and the server's clock.
 *   serverTime ≈ Date.now() + clockOffset
 * Starts at 0 (assume clocks match) and converges quickly after the first ping.
 */
let clockOffset = 0;

/** Returns the current server time estimated from our local clock. */
function serverNow() {
  return Date.now() + clockOffset;
}

/**
 * Send a ping to the server. Server echoes clientTime + serverTime.
 * We measure round-trip, halve it to estimate one-way latency, then derive offset.
 */
function sendClockPing() {
  socket.emit("ping-sync", Date.now());
}

// ── Socket.io connection ───────────────────────────────────────────────────────
// The socket.io client script is served automatically by the server at
// /socket.io/socket.io.js — no CDN or bundler needed.
const socket = io({ transports: ["websocket", "polling"] });

const syncIndicator = document.getElementById("syncIndicator");

socket.on("connect", () => {
  if (syncIndicator) syncIndicator.title = "Connected ⚡";
  sendClockPing();
  // Repeat every 30 s to keep clock offset accurate as clocks drift
  setInterval(sendClockPing, 30_000);
});

socket.on("disconnect", () => {
  if (syncIndicator) syncIndicator.classList.add("disconnected");
});

socket.on("reconnect", () => {
  if (syncIndicator) syncIndicator.classList.remove("disconnected");
  sendClockPing();
});

socket.on("pong-sync", ({ clientTime, serverTime }) => {
  const t1  = Date.now();
  const rtt = t1 - clientTime;          // round-trip latency in ms
  // Estimate when the server timestamp was recorded: halfway through the RTT
  const offset = serverTime - clientTime - rtt / 2;
  // Smooth: blend 80% old + 20% new to avoid jumps from network jitter
  clockOffset = clockOffset * 0.8 + offset * 0.2;
  if (syncIndicator) {
    syncIndicator.title = `Synced ⚡ offset=${Math.round(clockOffset)}ms rtt=${rtt}ms`;
  }
});


/* ═══════════════════════════════════════════════════════════════════════════
   §2  Video.js player
   ═══════════════════════════════════════════════════════════════════════════ */

let player = null;

/**
 * True while we are applying an incoming Socket.io event.
 * Prevents the player's own event listeners from re-broadcasting the change
 * back to the server and creating an infinite echo loop.
 */
let applyingSync = false;

/**
 * Holds a "play" event that arrived before Video.js was ready.
 * Applied immediately once the player reports ready.
 */
let pendingSync = null;

/** POST a sync command to the server (fire-and-forget). */
function postSync(url, body) {
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function initPlayer() {
  player = videojs("videoPlayer", {
    controls: true,
    preload: "auto",   // buffer aggressively — avoids mid-playback stalls
    playsinline: true,
    techOrder: ["html5"],
    controlBar: {
      skipButtons: { backward: 5, forward: 5 },
      children: [
        "playToggle", "skipBackward", "skipForward",
        "volumePanel", "currentTimeDisplay", "timeDivider",
        "durationDisplay", "progressControl", "fullscreenToggle",
      ],
    },
    inactivityTimeout: 3000,
  });

  player.ready(() => {
    initSeekOverlays();
    initKeyboardSeek();

    // Flush any sync event that arrived before the player was ready
    if (pendingSync) {
      const snap = pendingSync;
      pendingSync = null;
      applyPlayEvent(snap);
    }

    // ── Scrub-while-dragging broadcast ────────────────────────────────────────
    // Fire seek updates every 80 ms while the user is dragging the scrubber,
    // so all other tabs move their timeline in real-time.
    let seekBroadcastInterval = null;

    function startSeekBroadcast() {
      if (seekBroadcastInterval) return;
      seekBroadcastInterval = setInterval(() => {
        if (!activeFilename) return;
        postSync("/api/seek", { position: player.currentTime() || 0 });
      }, 80);
    }
    function stopSeekBroadcast() {
      if (seekBroadcastInterval) { clearInterval(seekBroadcastInterval); seekBroadcastInterval = null; }
    }

    player.on("pause", () => {
      if (applyingSync || !activeFilename) return;
      postSync("/api/pause", { position: player.currentTime() || 0 });
    });

    player.on("play", () => {
      if (applyingSync || !activeFilename) return;
      postSync("/api/resume", { position: player.currentTime() || 0 });
    });

    // Start broadcasting as soon as the user begins dragging
    player.on("seeking", () => {
      if (applyingSync || !activeFilename) return;
      startSeekBroadcast();
    });

    // Send one final accurate position on release, then stop
    player.on("seeked", () => {
      stopSeekBroadcast();
      if (applyingSync || !activeFilename) return;
      postSync("/api/seek", { position: player.currentTime() || 0 });
    });

    player.on("error", () => {
      const err = player.error();
      const msgs = {
        1: "Playback aborted.",
        2: "Network error — check your connection.",
        3: "Video cannot be decoded (unsupported format or corrupt file).",
        4: "Video format not supported by this browser (try MP4 or WebM).",
      };
      const text = (err && msgs[err.code]) || "Unknown playback error.";
      setNowPlaying("⚠ " + text);
      console.warn("Video.js error", err);
    });
  });
}


/* ═══════════════════════════════════════════════════════════════════════════
   §3  Socket.io sync listener
   Receives real-time play/pause/seek/library events from the server.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Apply a position from the server, accounting for the clock offset and any
 * time that has elapsed since the server recorded the state.
 *
 * @param {number} position     - position in seconds at the time serverTime was recorded
 * @param {number} serverTime   - server ms timestamp when position was captured
 * @param {boolean} paused      - whether the stream is paused
 */
function applyPosition(position, serverTime, paused) {
  if (!player) return;
  const livePos = paused
    ? position
    : position + (serverNow() - serverTime) / 1000;
  const clamped = Math.max(0, livePos);
  if (player.readyState() >= 1) {
    player.currentTime(clamped);
  } else {
    player.one("loadedmetadata", () => player.currentTime(clamped));
  }
}

socket.on("play", ({ filename, position = 0, serverTime = Date.now(), paused = false }) => {
  if (!filename) return;
  if (!player) {
    // Player not initialised yet (socket connected before window.load finished).
    // Store and replay once player.ready() fires.
    pendingSync = { filename, position, serverTime, paused };
    return;
  }
  applyPlayEvent({ filename, position, serverTime, paused });
});

function applyPlayEvent({ filename, position, serverTime, paused }) {
  applyingSync = true;
  playViaServer(filename).then(() => {
    applyPosition(position, serverTime, paused);
    if (paused) {
      if (player.readyState() >= 1) player.pause();
      else player.one("loadedmetadata", () => { applyingSync = true; player.pause(); });
    }
    setTimeout(() => { applyingSync = false; }, 300);
  });
}

socket.on("pause", ({ position, serverTime = Date.now() }) => {
  if (!player || !activeFilename) return;
  applyingSync = true;
  if (position != null) player.currentTime(position);
  player.pause();
  setTimeout(() => { applyingSync = false; }, 150);
});

socket.on("resume", ({ position, serverTime = Date.now() }) => {
  if (!player || !activeFilename) return;
  applyingSync = true;
  // Apply live position: account for time elapsed since the server recorded it
  const livePos = position + (serverNow() - serverTime) / 1000;
  player.currentTime(Math.max(0, livePos));
  player.play().catch(() => {});
  setTimeout(() => { applyingSync = false; }, 200);
});

socket.on("seek", ({ position, serverTime = Date.now() }) => {
  if (!player || !activeFilename) return;
  applyingSync = true;
  player.currentTime(Math.max(0, position));
  // Use a timeout instead of player.one("seeked") — seeked can be delayed
  // by buffering and leave applyingSync stuck as true indefinitely.
  setTimeout(() => { applyingSync = false; }, 600);
});

socket.on("library-updated", () => {
  loadServerVideos();
});

socket.on("faststart-done", ({ filename }) => {
  const card = videoList.querySelector(`[data-filename="${CSS.escape(filename)}"]`);
  if (card) {
    const row = card.querySelector(".faststart-row");
    if (row) row.remove();
    delete card.dataset.needsFaststart;
  }
  showToast(`✔ Fixed: ${filename} — smooth playback ready`);
});

socket.on("faststart-error", ({ filename, error }) => {
  const card = videoList.querySelector(`[data-filename="${CSS.escape(filename)}"]`);
  if (card) {
    const row = card.querySelector(".faststart-row");
    if (row) {
      row.innerHTML = `<span class="faststart-error">✖ ${esc(error)}</span>`;
    }
  }
});


/* ═══════════════════════════════════════════════════════════════════════════
   §4  Double-click / double-tap ±5 s seek
   ═══════════════════════════════════════════════════════════════════════════ */

const SEEK_S = 5;
let seekTimer = null;

function initSeekOverlays() {
  const el = player.el();
  el.addEventListener("dblclick", (e) => {
    if (e.target.closest(".vjs-control-bar")) return;
    const right = e.clientX - el.getBoundingClientRect().left > el.offsetWidth / 2;
    seek(right ? SEEK_S : -SEEK_S, right);
    e.stopPropagation();
  });
}

function seek(delta, isForward) {
  if (!player) return;
  const next = Math.min(Math.max((player.currentTime() || 0) + delta, 0), player.duration() || Infinity);
  player.currentTime(next);
  flashOverlay(isForward);
}

function flashOverlay(isForward) {
  const el = document.getElementById(isForward ? "seekOverlayRight" : "seekOverlayLeft");
  if (!el) return;
  el.classList.remove("active");
  void el.offsetWidth;
  el.classList.add("active");
  clearTimeout(seekTimer);
  seekTimer = setTimeout(() => el.classList.remove("active"), 650);
}


/* ═══════════════════════════════════════════════════════════════════════════
   §5  Keyboard / TV remote arrow keys
   ═══════════════════════════════════════════════════════════════════════════ */

function initKeyboardSeek() {
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    switch (e.key) {
      case "ArrowLeft":  e.preventDefault(); seek(-SEEK_S, false); break;
      case "ArrowRight": e.preventDefault(); seek(+SEEK_S, true);  break;
      case "ArrowUp":    e.preventDefault(); player && player.volume(Math.min((player.volume()||0)+.1, 1)); break;
      case "ArrowDown":  e.preventDefault(); player && player.volume(Math.max((player.volume()||0)-.1, 0)); break;
      case " ":
      case "Enter":
        e.preventDefault();
        player && (player.paused() ? player.play() : player.pause());
        break;
    }
  });
}


/* ═══════════════════════════════════════════════════════════════════════════
   §6  Video library
   ═══════════════════════════════════════════════════════════════════════════ */

const videoList     = document.getElementById("videoList");
const libraryStatus = document.getElementById("libraryStatus");
const refreshBtn    = document.getElementById("refreshBtn");
const localFiles    = new Map();
let   isLocalMode   = false;

async function loadServerVideos() {
  isLocalMode = false;
  localFiles.clear();
  showStatus("Loading…", false);
  videoList.innerHTML = "";

  let videos;
  try {
    const r = await fetch("/api/videos");
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `Server ${r.status}`);
    videos = body;
  } catch (err) {
    showStatus(`Error: ${err.message}`, true);
    return;
  }

  if (!videos.length) {
    showStatus("No videos yet. Tap ＋ Add video to upload one.", false);
    return;
  }

  hideStatus();
  videos.forEach(({ filename, needsFaststart }, i) =>
    videoList.appendChild(makeCard(filename, false, i, needsFaststart))
  );
}

function renderLocalFiles(files) {
  isLocalMode = true;
  videoList.innerHTML = "";
  if (!files.length) {
    showStatus("No .mp4/.mkv/.webm files in that folder.", false);
    return;
  }
  hideStatus();
  files.forEach((file, i) => {
    localFiles.set(file.name, file);
    videoList.appendChild(makeCard(file.name, true, i));
  });
}

function makeCard(filename, isLocal, _index, needsFaststart) {
  const ext      = filename.split(".").pop().toLowerCase();
  const baseName = filename.replace(/\.[^.]+$/, "");
  const icons    = { mp4: "🎬", mkv: "🎞️", webm: "📹" };

  const li = document.createElement("li");
  li.className        = "video-card" + (isLocal ? " local" : "");
  li.tabIndex         = 0;
  li.role             = "button";
  li.dataset.filename = filename;
  if (needsFaststart) li.dataset.needsFaststart = "1";

  li.innerHTML = `
    <div class="video-card-top">
      <span class="video-card-icon">${icons[ext] || "🎬"}</span>
      <div class="video-card-info">
        <div class="video-card-name" title="${esc(baseName)}">${esc(baseName)}</div>
        <div class="video-card-ext">${esc(ext.toUpperCase())}</div>
      </div>
    </div>
    ${needsFaststart ? `
    <div class="faststart-row">
      <span class="faststart-warn">⚠ Will buffer</span>
      <button class="faststart-btn" title="Fix for smooth playback (runs ffmpeg)">⚡ Fix</button>
    </div>` : ""}
  `;

  li.addEventListener("click", (e) => {
    if (e.target.closest(".faststart-btn")) return; // handled below
    broadcastPlay(filename);
  });
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); broadcastPlay(filename); }
  });

  if (needsFaststart) {
    const fixBtn = li.querySelector(".faststart-btn");
    fixBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      runFaststartFix(filename, li);
    });
  }

  return li;
}

/** POST /api/faststart/:filename — remux in-place with ffmpeg faststart. */
async function runFaststartFix(filename, cardEl) {
  const row    = cardEl.querySelector(".faststart-row");
  const fixBtn = cardEl.querySelector(".faststart-btn");
  if (!row || !fixBtn) return;

  fixBtn.disabled    = true;
  fixBtn.textContent = "⏳ Fixing…";
  row.querySelector(".faststart-warn").textContent = "Remuxing…";

  try {
    const r    = await fetch(`/api/faststart/${encodeURIComponent(filename)}`, { method: "POST" });
    const body = await r.json();
    if (!r.ok) {
      row.innerHTML = `<span class="faststart-error">✖ ${esc(body.error || "Failed")}</span>`;
      return;
    }
    if (!body.started) {
      // Already had faststart — no ffmpeg needed
      row.remove();
      delete cardEl.dataset.needsFaststart;
    }
    // Otherwise, wait for faststart-done / faststart-error socket events
  } catch (err) {
    row.innerHTML = `<span class="faststart-error">✖ ${esc(err.message)}</span>`;
  }
}

function showStatus(msg, isError) {
  libraryStatus.textContent = msg;
  libraryStatus.className   = "library-status" + (isError ? " error" : "");
  libraryStatus.hidden      = false;
}
function hideStatus() { libraryStatus.hidden = true; }
function esc(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
           .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}


/* ═══════════════════════════════════════════════════════════════════════════
   §7  Upload (Add to library)
   ═══════════════════════════════════════════════════════════════════════════ */

const uploadInput  = document.getElementById("uploadInput");
const uploadStatus = document.getElementById("uploadStatus");

uploadInput.addEventListener("change", async () => {
  const file = uploadInput.files[0];
  if (!file) return;
  uploadInput.value = "";

  showUploadStatus(`Uploading ${file.name}…`, false, true);

  const fd = new FormData();
  fd.append("video", file);

  try {
    const r    = await fetch("/api/upload", { method: "POST", body: fd });
    const body = await r.json();
    if (!r.ok) { showUploadStatus(`Upload failed: ${body.error}`, true); return; }
    if (body.transcoding) {
      showUploadStatus("⚙ Converting to MP4… library updates when done", false, true);
    } else {
      showUploadStatus(`✔ Added "${body.filename}" to library`, false);
      await loadServerVideos();
      setTimeout(() => { if (uploadStatus) uploadStatus.hidden = true; }, 3000);
    }
  } catch (e) {
    showUploadStatus(`Upload failed: ${e.message}`, true);
  }
});

function showUploadStatus(msg, isError, isProgress) {
  uploadStatus.textContent = msg;
  uploadStatus.className   = "upload-status" +
    (isError ? " error" : "") + (isProgress ? " progress" : "");
  uploadStatus.hidden = false;
}


/* ═══════════════════════════════════════════════════════════════════════════
   §8  Folder picker
   ═══════════════════════════════════════════════════════════════════════════ */

const folderToggleBtn   = document.getElementById("folderToggleBtn");
const folderPanel       = document.getElementById("folderPanel");
const browseBtn         = document.getElementById("browseBtn");
const folderPathInput   = document.getElementById("folderPathInput");
const setFolderBtn      = document.getElementById("setFolderBtn");
const folderCurrentPath = document.getElementById("folderCurrentPath");
const folderError       = document.getElementById("folderError");

folderToggleBtn.addEventListener("click", () => {
  folderPanel.hidden = !folderPanel.hidden;
  if (!folderPanel.hidden) clearFolderError();
});

browseBtn.addEventListener("click", async () => {
  if (!("showDirectoryPicker" in window)) {
    showFolderError("Folder picker needs localhost/https. Use the path input instead.");
    return;
  }
  let dirHandle;
  try { dirHandle = await window.showDirectoryPicker({ mode: "read" }); }
  catch (e) { if (e.name !== "AbortError") showFolderError(e.message); return; }

  const supported = new Set(["mp4", "mkv", "webm"]);
  const list = [];
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== "file") continue;
      const ext = name.split(".").pop().toLowerCase();
      if (supported.has(ext)) list.push(await handle.getFile());
    }
  } catch (e) { showFolderError(e.message); return; }

  list.sort((a, b) => a.name.localeCompare(b.name));
  clearFolderError();
  folderCurrentPath.textContent = `📂 ${dirHandle.name} (${list.length} video${list.length !== 1 ? "s" : ""})`;
  folderPanel.hidden = true;
  renderLocalFiles(list);
});

setFolderBtn.addEventListener("click", applyServerPath);
folderPathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") applyServerPath(); });

async function applyServerPath() {
  const p = folderPathInput.value.trim();
  if (!p) { showFolderError("Enter a folder path."); return; }
  setFolderBtn.disabled = true;
  clearFolderError();
  try {
    const r    = await fetch("/api/set-video-dir", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
    const body = await r.json();
    if (!r.ok) { showFolderError(body.error || `Error ${r.status}`); return; }
    folderCurrentPath.textContent = `✔ Serving: ${body.path}`;
    folderPathInput.value = "";
    folderPanel.hidden = true;
    await loadServerVideos();
  } catch (e) { showFolderError(e.message); }
  finally     { setFolderBtn.disabled = false; }
}

async function loadCurrentVideoDir() {
  try {
    const r = await fetch("/api/video-dir");
    if (!r.ok) return;
    const { path: dir } = await r.json();
    folderCurrentPath.textContent = `📂 Current: ${dir}`;
    folderPathInput.placeholder   = dir;
  } catch {}
}

function showFolderError(msg) { folderError.textContent = msg; folderError.hidden = false; }
function clearFolderError()   { folderError.hidden = true; folderError.textContent = ""; }


/* ═══════════════════════════════════════════════════════════════════════════
   §9  Playback router
   ═══════════════════════════════════════════════════════════════════════════ */

let activeFilename = null;

/**
 * Broadcast a play command to ALL connected clients (including yourself).
 * The socket "play" listener in §3 handles the actual playback for everyone.
 */
async function broadcastPlay(filename) {
  try {
    await fetch("/api/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, position: 0 }),
    });
  } catch (e) {
    console.warn("broadcastPlay failed:", e);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   HLS state — tracks in-progress and ready HLS jobs
   ═══════════════════════════════════════════════════════════════════════════ */

/** filename → "generating" | "ready" */
const hlsState = new Map();

socket.on("hls-segment", ({ filename, count }) => {
  hlsState.set(filename, "generating");
  updateHlsCardState(filename, "generating", count);
  // If this is the first segment and it's the active video, switch to HLS
  if (count === 1 && filename === activeFilename) {
    loadHlsSrc(filename);
  }
});

socket.on("hls-ready", ({ filename }) => {
  hlsState.set(filename, "ready");
  updateHlsCardState(filename, "ready");
});

socket.on("hls-error", ({ filename, error }) => {
  hlsState.delete(filename);
  updateHlsCardState(filename, "error", 0, error);
  if (filename === activeFilename) {
    showToast(`HLS failed — playing directly: ${error}`);
    fallbackDirectPlay(filename);
  }
});

/** Switch the player to the HLS manifest for the active video. */
function loadHlsSrc(filename) {
  if (!player || filename !== activeFilename) return;
  const src = `/api/hls/${encodeURIComponent(filename)}/index.m3u8`;
  const current = player.currentSrc() || "";
  if (current.endsWith("index.m3u8")) return; // already on HLS
  const pos = player.currentTime() || 0;
  player.src({ src, type: "application/x-mpegURL" });
  if (pos > 0) player.one("loadedmetadata", () => player.currentTime(pos));
  player.play().catch(() => {});
}

function fallbackDirectPlay(filename) {
  if (!player || filename !== activeFilename) return;
  const ext  = filename.split(".").pop().toLowerCase();
  const mime = { mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm" };
  player.src({ src: `/video/${encodeURIComponent(filename)}`, type: mime[ext] || "video/mp4" });
  player.play().catch(() => {});
}

function updateHlsCardState(filename, status, count, error) {
  const card = videoList.querySelector(`[data-filename="${CSS.escape(filename)}"]`);
  if (!card) return;
  let row = card.querySelector(".hls-row");
  if (!row) {
    row = document.createElement("div");
    row.className = "hls-row";
    card.appendChild(row);
  }
  if (status === "generating") {
    row.innerHTML = `<span class="hls-badge hls-loading">⚡ Preparing… seg ${count}</span>`;
  } else if (status === "ready") {
    row.innerHTML = `<span class="hls-badge hls-ready">⚡ Smooth</span>`;
    setTimeout(() => { if (row.parentElement) row.remove(); }, 3000);
  } else if (status === "error") {
    row.innerHTML = `<span class="hls-badge hls-err" title="${esc(error || '')}">⚠ HLS failed</span>`;
    setTimeout(() => { if (row.parentElement) row.remove(); }, 4000);
  }
}

async function playViaServer(filename) {
  if (!player) return;

  activeFilename = filename;
  hidePlaceholder();
  setNowPlaying(filename);
  highlightCard(filename);

  // 1. Try HLS — request the server to start (or resume) segmentation
  try {
    // We need the video-dir to tell the HLS endpoint where to find the file
    const dirRes  = await fetch("/api/video-dir");
    const dirBody = dirRes.ok ? await dirRes.json() : null;
    const videoDir = dirBody?.path ?? "";

    const hlsRes  = await fetch(
      `/api/hls/start/${encodeURIComponent(filename)}?videoDir=${encodeURIComponent(videoDir)}`,
      { method: "POST" }
    );
    if (hlsRes.ok) {
      const hlsBody = await hlsRes.json();
      if (hlsBody.status === "ready") {
        // HLS already fully generated — play immediately
        hlsState.set(filename, "ready");
        player.src({ src: hlsBody.hlsPath, type: "application/x-mpegURL" });
        player.play().catch(() => {});
        return;
      }
      if (hlsBody.status === "generating" && hlsBody.segments >= 1) {
        // Enough segments already exist — start playing HLS now
        hlsState.set(filename, "generating");
        loadHlsSrc(filename);
        return;
      }
      // Generating but no segments yet — show the card indicator and wait
      // for the hls-segment socket event (§3 above) to kick off playback
      hlsState.set(filename, "generating");
      updateHlsCardState(filename, "generating", hlsBody.segments ?? 0);
      // Also start direct playback immediately as fallback while waiting
    }
  } catch { /* HLS unavailable — fall through to direct play */ }

  // 2. Fall back to direct HTTP range streaming
  fallbackDirectPlay(filename);
}

function hidePlaceholder() {
  document.getElementById("playerPlaceholder")?.classList.add("hidden");
}

function setNowPlaying(filename) {
  const bar  = document.getElementById("nowPlaying");
  const name = document.getElementById("nowPlayingName");
  if (bar && name) { name.textContent = filename; bar.hidden = false; }
}

function highlightCard(filename) {
  videoList.querySelectorAll(".video-card").forEach((c) =>
    c.classList.toggle("active", c.dataset.filename === filename)
  );
}


/* ═══════════════════════════════════════════════════════════════════════════
   §10 Toast notifications
   ═══════════════════════════════════════════════════════════════════════════ */

let toastTimer = null;

function showToast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 3500);
}

/* ═══════════════════════════════════════════════════════════════════════════
   §11 Boot
   ═══════════════════════════════════════════════════════════════════════════ */

refreshBtn.addEventListener("click", async () => {
  refreshBtn.classList.add("spinning");
  await loadServerVideos();
  setTimeout(() => refreshBtn.classList.remove("spinning"), 350);
});

window.addEventListener("load", () => {
  initPlayer();
  loadCurrentVideoDir();
  loadServerVideos();
});
