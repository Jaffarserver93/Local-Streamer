/**
 * script.js — Local Stream
 *
 * Sections:
 *   1.  Video.js v10 player initialisation
 *   2.  Double-click / double-tap ±5 s seek (YouTube style)
 *   3.  Keyboard / TV-remote arrow-key seek (← −5 s  |  → +5 s)
 *   4.  Video library — server-side listing
 *   5.  Folder picker
 *        A. Browser folder picker (File System Access API)  → local playback
 *        B. Server path input → POST /api/set-video-dir    → network + Cast
 *   6.  Playback router (local HTML5 vs Chromecast)
 *   7.  Chromecast (Google Cast SDK v3)
 *   8.  Boot
 */

/* ═══════════════════════════════════════════════════════════════════════════
   §1  Video.js v10 player
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * videojs() is injected globally by the Video.js <script> tag loaded in
 * index.html just before this file.
 *
 * v10 options reference:
 *   https://videojs.com/guides/options/
 */
let player = null; // set in initPlayer(), referenced everywhere else

function initPlayer() {
  player = videojs("videoPlayer", {
    controls: true,
    preload: "metadata",
    playsinline: true,
    // fluid + aspectRatio makes the player fill its CSS container responsively
    fluid: true,
    aspectRatio: "16:9",
    // HTML5 tech first (native browser decoder), flash is gone in v10
    techOrder: ["html5"],
    // Custom control bar — skip buttons at ±5 s appear automatically
    controlBar: {
      skipButtons: {
        backward: 5,
        forward: 5,
      },
      children: [
        "playToggle",
        "skipBackward",
        "skipForward",
        "volumePanel",
        "currentTimeDisplay",
        "timeDivider",
        "durationDisplay",
        "progressControl",
        "remainingTimeDisplay",
        "fullscreenToggle",
      ],
    },
    // User-activity timeout: hide controls after 3 s of inactivity
    inactivityTimeout: 3000,
  });

  // Once the player is ready, wire the seek interactions on top of it
  player.ready(() => {
    initSeekOverlays();
    initKeyboardSeek();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   §2  Double-click / double-tap ±5 s seek overlays
   ═══════════════════════════════════════════════════════════════════════════

   How it works
   ─────────────
   The two .seek-overlay divs sit OVER the Video.js player with pointer-events
   disabled by default. We listen for dblclick on the Video.js player element
   itself, detect left vs. right half, adjust currentTime by ±5 s, then
   briefly activate the matching overlay to show the ripple + label animation.

   Touch devices (phone/tablet) — double-tap also fires `dblclick` in modern
   browsers, so no separate touch handling is needed.
   ═══════════════════════════════════════════════════════════════════════════ */

const SEEK_SECONDS = 5;
let seekTimeout = null; // timer used to clear the overlay animation

function initSeekOverlays() {
  const playerEl = player.el();

  playerEl.addEventListener("dblclick", (e) => {
    // Ignore clicks on the control bar so playback controls still work
    if (e.target.closest(".vjs-control-bar")) return;

    const rect = playerEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const isRightSide = x > rect.width / 2;

    seek(isRightSide ? SEEK_SECONDS : -SEEK_SECONDS, isRightSide);

    // Prevent the dblclick from also toggling play/pause
    e.stopPropagation();
  });
}

/**
 * Seeks the player by `delta` seconds and triggers the matching overlay.
 * @param {number}  delta       — positive = forward, negative = back
 * @param {boolean} isForward   — true = right overlay, false = left overlay
 */
function seek(delta, isForward) {
  if (!player) return;

  const current = player.currentTime();
  const duration = player.duration() || Infinity;
  const next = Math.min(Math.max(current + delta, 0), duration);
  player.currentTime(next);

  triggerSeekOverlay(isForward);
}

/**
 * Shows the seek overlay for ~650 ms then hides it.
 * Uses CSS class `active` which drives the ripple + label animations in CSS.
 */
function triggerSeekOverlay(isForward) {
  const id = isForward ? "seekOverlayRight" : "seekOverlayLeft";
  const el = document.getElementById(id);
  if (!el) return;

  // Reset any previous animation by removing then immediately re-adding
  el.classList.remove("active");
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add("active");

  clearTimeout(seekTimeout);
  seekTimeout = setTimeout(() => el.classList.remove("active"), 650);
}

/* ═══════════════════════════════════════════════════════════════════════════
   §3  Keyboard / TV-remote seek
   ═══════════════════════════════════════════════════════════════════════════

   Most Smart TV remotes map directional keys to keyboard events:
     ArrowLeft  / VK_LEFT  (keyCode 37) →  −5 s
     ArrowRight / VK_RIGHT (keyCode 39) →  +5 s
     ArrowUp    / VK_UP    (keyCode 38) →  volume +10 %
     ArrowDown  / VK_DOWN  (keyCode 40) →  volume −10 %
     Space / Enter         (keyCode 32/13) → toggle play/pause

   We listen on document so it works even when no element has focus.
   We skip keys when the user is typing in a text input to avoid conflicts.
   ═══════════════════════════════════════════════════════════════════════════ */

function initKeyboardSeek() {
  document.addEventListener("keydown", (e) => {
    // Don't intercept keys while the user types in an input/textarea
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea") return;

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        seek(-SEEK_SECONDS, false);
        break;
      case "ArrowRight":
        e.preventDefault();
        seek(SEEK_SECONDS, true);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (player) player.volume(Math.min((player.volume() || 0) + 0.1, 1));
        break;
      case "ArrowDown":
        e.preventDefault();
        if (player) player.volume(Math.max((player.volume() || 0) - 0.1, 0));
        break;
      case " ":
      case "Enter":
        e.preventDefault();
        if (player) player.paused() ? player.play() : player.pause();
        break;
      default:
        break;
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   §4  Video library — server-side listing
   ═══════════════════════════════════════════════════════════════════════════ */

const videoList     = document.getElementById("videoList");
const libraryStatus = document.getElementById("libraryStatus");
const refreshBtn    = document.getElementById("refreshBtn");

/**
 * Holds locally-opened File objects from the folder picker (§5A).
 * Key = filename string, value = File
 * @type {Map<string, File>}
 */
const localFiles = new Map();

/** Whether the library is currently showing local files (folder-picker mode) */
let isLocalMode = false;

/**
 * Fetches /api/videos from the server and renders cards.
 * Switches out of local-file mode if currently in it.
 */
async function loadServerVideos() {
  isLocalMode = false;
  localFiles.clear();

  showStatus("Loading…", false);
  videoList.innerHTML = "";

  let videos;
  try {
    const r = await fetch("/api/videos");
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `Server ${r.status}`);
    }
    videos = await r.json();
  } catch (err) {
    showStatus(`Error: ${err.message}`, true);
    return;
  }

  if (!videos.length) {
    showStatus(
      "No videos found. Add .mp4 / .mkv / .webm files to the server folder, or tap 📁 to pick a folder.",
      false
    );
    return;
  }

  hideStatus();
  videos.forEach(({ filename }, i) => videoList.appendChild(createCard(filename, false, i)));
}

/**
 * Renders a list of local File objects as cards (from browser folder picker).
 * @param {File[]} files
 */
function renderLocalFiles(files) {
  isLocalMode = true;
  videoList.innerHTML = "";
  hideStatus();

  if (!files.length) {
    showStatus("No supported videos (.mp4, .mkv, .webm) in the selected folder.", false);
    return;
  }

  files.forEach((file, i) => {
    localFiles.set(file.name, file);
    const card = createCard(file.name, true, i);
    videoList.appendChild(card);
  });
}

/** Builds a single video card <li> element */
function createCard(filename, isLocal, index) {
  const ext = filename.split(".").pop().toLowerCase();
  const baseName = filename.replace(/\.[^.]+$/, "");
  const icons = { mp4: "🎬", mkv: "🎞️", webm: "📹" };

  const li = document.createElement("li");
  li.className = "video-card" + (isLocal ? " local" : "");
  li.tabIndex = 0;
  li.role = "button";
  li.dataset.filename = filename;

  li.innerHTML = `
    <span class="video-card-icon">${icons[ext] || "🎬"}</span>
    <div class="video-card-info">
      <div class="video-card-name" title="${esc(baseName)}">${esc(baseName)}</div>
      <div class="video-card-ext">${esc(ext)}</div>
      ${isLocal ? '<div class="video-card-badge">LOCAL</div>' : ""}
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
  libraryStatus.className = "library-status" + (isError ? " error" : "");
  libraryStatus.hidden = false;
}
function hideStatus() { libraryStatus.hidden = true; }

/** Minimal HTML-escape to prevent XSS from filenames */
function esc(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
          .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

/* ═══════════════════════════════════════════════════════════════════════════
   §5  Folder picker
   ═══════════════════════════════════════════════════════════════════════════ */

// ── DOM refs ──────────────────────────────────────────────────────────────────
const folderToggleBtn   = document.getElementById("folderToggleBtn");
const folderPanel       = document.getElementById("folderPanel");
const browseBtn         = document.getElementById("browseBtn");
const folderPathInput   = document.getElementById("folderPathInput");
const setFolderBtn      = document.getElementById("setFolderBtn");
const folderCurrentPath = document.getElementById("folderCurrentPath");
const folderError       = document.getElementById("folderError");

folderToggleBtn.addEventListener("click", () => {
  const hidden = folderPanel.hidden;
  folderPanel.hidden = !hidden;
  if (!hidden) clearFolderError();
});

// ── §5A  Browser folder picker (File System Access API) ───────────────────────
//
// Uses window.showDirectoryPicker() to open a native OS folder-picker dialog.
//
// IMPORTANT: showDirectoryPicker() requires a SECURE CONTEXT (https:// or
// localhost). If accessed via http://192.168.x.x this will NOT work — use
// Option B (server path input) instead for over-the-network access.

browseBtn.addEventListener("click", async () => {
  if (!("showDirectoryPicker" in window)) {
    showFolderError(
      "Your browser doesn't support the folder picker. " +
      "Access the app on localhost, or use the path input below instead."
    );
    return;
  }

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "read" });
  } catch (err) {
    // User cancelled — not an error
    if (err.name === "AbortError") return;
    showFolderError(`Folder picker failed: ${err.message}`);
    return;
  }

  // Scan for supported video files in the selected directory
  const supported = new Set(["mp4", "mkv", "webm"]);
  const videoFileList = [];

  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== "file") continue;
      const ext = name.split(".").pop().toLowerCase();
      if (!supported.has(ext)) continue;
      const file = await handle.getFile();
      videoFileList.push(file);
    }
  } catch (err) {
    showFolderError(`Error reading folder: ${err.message}`);
    return;
  }

  // Sort alphabetically
  videoFileList.sort((a, b) => a.name.localeCompare(b.name));

  clearFolderError();
  folderCurrentPath.textContent = `📂 ${dirHandle.name}  (${videoFileList.length} video${videoFileList.length !== 1 ? "s" : ""})`;
  folderPanel.hidden = true;

  renderLocalFiles(videoFileList);
});

// ── §5B  Server-side path input → POST /api/set-video-dir ────────────────────
//
// Lets you type any absolute path on the server machine and hot-swap the
// VIDEO_DIR without restarting the server. Works over the network, so
// Smart TVs and Chromecast will immediately pick up the new folder.

setFolderBtn.addEventListener("click", applyServerPath);
folderPathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyServerPath();
});

async function applyServerPath() {
  const newPath = folderPathInput.value.trim();
  if (!newPath) {
    showFolderError("Please enter a folder path.");
    return;
  }

  setFolderBtn.disabled = true;
  clearFolderError();

  try {
    const r = await fetch("/api/set-video-dir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: newPath }),
    });
    const body = await r.json();

    if (!r.ok) {
      showFolderError(body.error || `Server error ${r.status}`);
      return;
    }

    // Success — update UI and reload the library
    folderCurrentPath.textContent = `✔ Now serving: ${body.path}`;
    folderPathInput.value = "";
    folderPanel.hidden = true;
    await loadServerVideos();
  } catch (err) {
    showFolderError(`Network error: ${err.message}`);
  } finally {
    setFolderBtn.disabled = false;
  }
}

/** Show current path on panel open */
async function loadCurrentVideoDir() {
  try {
    const r = await fetch("/api/video-dir");
    if (!r.ok) return;
    const { path: dir } = await r.json();
    folderCurrentPath.textContent = `📂 Current: ${dir}`;
    folderPathInput.placeholder = dir;
  } catch {
    // Non-critical — ignore
  }
}

function showFolderError(msg) {
  folderError.textContent = msg;
  folderError.hidden = false;
}
function clearFolderError() {
  folderError.hidden = true;
  folderError.textContent = "";
}

/* ═══════════════════════════════════════════════════════════════════════════
   §6  Playback router
   ═══════════════════════════════════════════════════════════════════════════ */

let activeFilename = null;
let isCasting      = false;

/**
 * Central dispatch:
 *   - local-file mode  → play blob URL directly
 *   - casting active   → stream to Chromecast
 *   - default          → play via Video.js from /video/:filename
 */
function playVideo(filename) {
  activeFilename = filename;
  highlightActiveCard(filename);

  if (isLocalMode && localFiles.has(filename)) {
    playLocalFile(filename);
  } else if (isCasting) {
    castVideo(filename);
  } else {
    playViaServer(filename);
  }
}

/**
 * Plays a locally-selected File object using a blob: URL.
 * Seeking works because the browser can read the file directly.
 */
function playLocalFile(filename) {
  const file = localFiles.get(filename);
  if (!file) return;

  hidePlaceholder();

  // Revoke any previous blob URL to free memory
  const prev = player.currentSrc?.();
  if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);

  const blobUrl = URL.createObjectURL(file);
  const ext = filename.split(".").pop().toLowerCase();
  const mime = { mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm" };

  player.src({ src: blobUrl, type: mime[ext] || "video/mp4" });
  player.play().catch(() => {});
  setNowPlaying(filename);
}

/**
 * Plays a server-side video via Video.js using the /video/:filename endpoint.
 * The browser automatically negotiates Range requests for seeking.
 */
function playViaServer(filename) {
  hidePlaceholder();

  const ext = filename.split(".").pop().toLowerCase();
  const mime = { mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm" };
  const src  = `/video/${encodeURIComponent(filename)}`;

  player.src({ src, type: mime[ext] || "video/mp4" });
  player.play().catch(() => {});
  setNowPlaying(filename);
}

function hidePlaceholder() {
  document.getElementById("playerPlaceholder")?.classList.add("hidden");
}

function setNowPlaying(filename) {
  const bar  = document.getElementById("nowPlaying");
  const name = document.getElementById("nowPlayingName");
  if (bar && name) { name.textContent = filename; bar.hidden = false; }
}

function highlightActiveCard(filename) {
  videoList.querySelectorAll(".video-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.filename === filename);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   §7  Chromecast (Google Cast SDK v3 — CAF)
   ═══════════════════════════════════════════════════════════════════════════

   Flow:
     1. SDK loads → fires __onGCastApiAvailable → initializeCastContext()
     2. User taps the cast button → SDK handles device discovery + session UI
     3. SESSION_STARTED / SESSION_RESUMED → isCasting = true
     4. User clicks a video → castVideo() builds a MediaInfo + LoadRequest
        and sends it to the TV; the TV's Cast receiver fetches the video
        directly from our server using Range requests
     5. SESSION_ENDED → isCasting = false, resume local playback

   NOTE: For Cast to work, the phone and the Chromecast must be on the SAME
   Wi-Fi network, and the Cast receiver must be able to reach the server URL.
   window.location.origin resolves to http://<server-ip>:<port> automatically.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Called by the Cast SDK when it finishes loading.
 * Name is fixed by the SDK contract — do NOT rename.
 */
window.__onGCastApiAvailable = function (isAvailable) {
  if (isAvailable) initializeCastContext();
};

function initializeCastContext() {
  const ctx = cast.framework.CastContext.getInstance();

  ctx.setOptions({
    // DEFAULT_MEDIA_RECEIVER_APP_ID plays any URL without a registered receiver
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });

  ctx.addEventListener(
    cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
    onSessionStateChange
  );
}

function onSessionStateChange(event) {
  const S = cast.framework.SessionState;
  switch (event.sessionState) {
    case S.SESSION_STARTED:
    case S.SESSION_RESUMED:
      isCasting = true;
      setCastStatus(true, "Connected");
      if (activeFilename && !isLocalMode) castVideo(activeFilename);
      break;
    case S.SESSION_ENDED:
    case S.SESSION_START_FAILED:
      isCasting = false;
      setCastStatus(false, "");
      if (activeFilename) playViaServer(activeFilename);
      break;
  }
}

function setCastStatus(connected, msg) {
  const el = document.getElementById("castStatus");
  if (!el) return;
  el.textContent = msg;
  el.className = "cast-status" + (connected ? " connected" : "");
}

/**
 * Sends a server-side video to the active Chromecast session.
 *
 * The Cast receiver on the TV opens a direct HTTP connection to this server
 * and streams via Range requests — identical to what a browser does.
 * window.location.origin gives the full http://IP:PORT so the TV can reach it.
 */
function castVideo(filename) {
  if (isLocalMode) {
    alert("Local files can't be cast to TV — use a server-path folder (tap 📁 and type the path) to enable casting.");
    return;
  }

  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  if (!session) {
    playViaServer(filename);
    return;
  }

  // Full network URL — the TV fetches this directly
  const videoUrl = `${window.location.origin}/video/${encodeURIComponent(filename)}`;
  const ext = filename.split(".").pop().toLowerCase();
  const mime = { mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm" };

  const mediaInfo = new chrome.cast.media.MediaInfo(videoUrl, mime[ext] || "video/mp4");
  mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
  mediaInfo.metadata.title = filename.replace(/\.[^.]+$/, ""); // strip extension

  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  request.autoplay = true;

  session.loadMedia(request).then(
    () => {
      const bar  = document.getElementById("nowPlaying");
      const name = document.getElementById("nowPlayingName");
      if (bar && name) { name.textContent = `📺 Casting: ${filename}`; bar.hidden = false; }
    },
    (code) => {
      console.error("Cast loadMedia error:", code);
      alert(`Cast failed (code ${code}). Playing locally instead.`);
      playViaServer(filename);
    }
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   §8  Boot
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
