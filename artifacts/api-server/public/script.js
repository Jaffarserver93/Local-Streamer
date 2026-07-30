/**
 * script.js — Local Stream
 *
 * ─── How "Send to TV" works ───────────────────────────────────────────────────
 *
 *   PHONE                              SERVER                    TV
 *   ─────                              ──────                    ──
 *   Tap "📤 Send to TV"
 *   → pick video from storage
 *   → XHR POST /upload ──────────────► save to disk
 *                                      broadcast SSE "play" ───► receive "play" event
 *                                                                 videojs.src(url)
 *                                                                 videojs.play()
 *
 *   Tap "▶ Play on TV" (library card)
 *   → POST /api/play ────────────────► broadcast SSE "play" ───► auto-plays
 *
 * ─── SSE connection ───────────────────────────────────────────────────────────
 *   Both TV and phone connect to GET /events on page load.
 *   EventSource auto-reconnects if the connection drops.
 *
 * Sections:
 *   §1  Video.js player
 *   §2  Double-click / double-tap ±5 s seek
 *   §3  Keyboard / TV remote arrow-key seek
 *   §4  Server-Sent Events (SSE) — receive play commands from phone
 *   §5  Video library (server-side + local files)
 *   §6  Send-to-TV — file upload from phone
 *   §7  Folder picker
 *   §8  Playback router (local / server / Chromecast)
 *   §9  Chromecast
 *   §10 Boot
 */

/* ═══════════════════════════════════════════════════════════════════════════
   §1  Video.js player
   ═══════════════════════════════════════════════════════════════════════════ */

let player = null;

function initPlayer() {
  player = videojs("videoPlayer", {
    controls: true,
    preload: "metadata",
    playsinline: true,
    // fluid/aspectRatio removed — sizing is handled entirely by CSS
    // (.video-js { position:absolute; inset:0; width:100%; height:100% })
    // Enabling fluid here would fight the CSS and produce a zero-height player.
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

    // Show a human-readable error if a video fails to load/decode
    player.on("error", () => {
      const err = player.error();
      const msgs = {
        1: "Playback aborted.",
        2: "Network error — check your connection.",
        3: "Video cannot be decoded (unsupported format or corrupt file).",
        4: "Video format not supported by this browser (try MP4/WebM).",
      };
      const text = (err && msgs[err.code]) || "Unknown playback error.";
      setNowPlaying("⚠ " + text);
      console.warn("Video.js error", err);
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   §2  Double-click / double-tap ±5 s seek
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
   §3  Keyboard / TV remote arrow keys
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
   §5  Video library
   ═══════════════════════════════════════════════════════════════════════════ */

const videoList     = document.getElementById("videoList");
const libraryStatus = document.getElementById("libraryStatus");
const refreshBtn    = document.getElementById("refreshBtn");

/** Local File objects from the folder picker, keyed by filename */
const localFiles = new Map();
let isLocalMode  = false;

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
    showStatus(
      "No videos yet. Tap 📤 to send a video from your phone, or add files to the server folder.",
      false
    );
    return;
  }

  hideStatus();
  videos.forEach(({ filename }, i) => videoList.appendChild(makeCard(filename, false, i)));
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

/**
 * Creates a video card — click to play on this device.
 */
function makeCard(filename, isLocal, _index) {
  const ext      = filename.split(".").pop().toLowerCase();
  const baseName = filename.replace(/\.[^.]+$/, "");
  const icons    = { mp4: "🎬", mkv: "🎞️", webm: "📹" };

  const li = document.createElement("li");
  li.className   = "video-card" + (isLocal ? " local" : "");
  li.tabIndex    = 0;
  li.role        = "button";
  li.dataset.filename = filename;

  li.innerHTML = `
    <div class="video-card-top">
      <span class="video-card-icon">${icons[ext] || "🎬"}</span>
      <div class="video-card-info">
        <div class="video-card-name" title="${esc(baseName)}">${esc(baseName)}</div>
        <div class="video-card-ext">${esc(ext)}</div>
      </div>
    </div>
  `;

  li.addEventListener("click", () => playVideo(filename));
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playVideo(filename); }
  });

  return li;
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
   §7  Folder picker
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
  finally { setFolderBtn.disabled = false; }
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
   §8  Playback router
   ═══════════════════════════════════════════════════════════════════════════ */

let activeFilename = null;

function playVideo(filename) {
  activeFilename = filename;
  highlightCard(filename);
  if (isLocalMode && localFiles.has(filename)) playLocalFile(filename);
  else                                         playViaServer(filename);
}

function playLocalFile(filename) {
  if (!player) return;   // guard: Video.js might not have initialised yet
  const file = localFiles.get(filename);
  if (!file) return;
  hidePlaceholder();

  // Revoke previous blob URL to avoid memory leaks
  const prev = player?.currentSrc?.();
  if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);

  const ext  = filename.split(".").pop().toLowerCase();
  const mime = { mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm" };
  const blobUrl = URL.createObjectURL(file);

  // Call play() synchronously while still inside the user-tap gesture so
  // mobile Chrome's autoplay policy allows it. Video.js queues the play
  // internally until the source has loaded — no need to wait for loadedmetadata.
  player.src({ src: blobUrl, type: mime[ext] || "video/mp4" });
  player.play().catch((e) => console.warn("play() rejected:", e));
  setNowPlaying(filename);
}

function playViaServer(filename) {
  if (!player) return;
  hidePlaceholder();
  const ext  = filename.split(".").pop().toLowerCase();
  const mime = { mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm" };
  player.src({ src: `/video/${encodeURIComponent(filename)}`, type: mime[ext] || "video/mp4" });
  // Call play() synchronously (still inside the user-tap gesture) so mobile
  // Chrome allows it. Video.js queues the play until the source has loaded.
  player.play().catch((e) => console.warn("play() rejected:", e));
  setNowPlaying(filename);
  highlightCard(filename);
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
   §9  Chromecast
   ═══════════════════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════════════════
   §10 Boot
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
