/**
 * script.js — Local Stream
 *
 * Each browser/TV is an independent viewer — pick any video from the library
 * and it plays only on your screen.  Socket.io is used only for HLS progress
 * events and library-change notifications (upload, faststart fix).
 *
 * Sections:
 *   §1  Video.js player
 *   §2  Socket.io events (HLS + library)
 *   §3  Double-tap ±5 s seek
 *   §4  Keyboard / TV remote
 *   §5  Video library
 *   §6  Upload (Add to library)
 *   §7  Folder picker
 *   §8  Playback router
 *   §9  Boot
 */

// ── Socket.io connection ───────────────────────────────────────────────────────
// Used only for HLS progress events and library change notifications.
const socket = io({ transports: ["websocket", "polling"] });


/* ═══════════════════════════════════════════════════════════════════════════
   §1  Video.js player
   ═══════════════════════════════════════════════════════════════════════════ */

let player = null;

// ── Custom Settings Gear Icon Button ─────────────────────────────────────────
const Button = videojs.getComponent("Button");
class SettingsButton extends Button {
  constructor(player, options) {
    super(player, options);
    this.controlText("Settings");
  }
  buildCSSClass() {
    return `vjs-settings-button ${super.buildCSSClass()}`;
  }
  handleClick() {
    toggleSettingsPanel();
  }
}
videojs.registerComponent("SettingsButton", SettingsButton);

function initPlayer() {
  player = videojs("videoPlayer", {
    controls: true,
    bigPlayButton: false,
    preload: "auto",
    playsinline: true,
    techOrder: ["html5"],
    controlBar: {
      skipButtons: { backward: 5, forward: 5 },
      children: [
        "playToggle", "skipBackward", "skipForward",
        "volumePanel", "currentTimeDisplay", "timeDivider",
        "durationDisplay", "progressControl", "SettingsButton", "fullscreenToggle",
      ],
    },
    inactivityTimeout: 3000,
    // Disable built-in double-click fullscreen toggle so our left/right
    // seek zones handle double-click without exiting fullscreen on TV.
    userActions: { doubleClick: false },
  });

  player.ready(() => {
    initTapOverlay();
    initKeyboardSeek();
    initSubtitleLoader();
    initSettingsMenu();
    initProgressBarThumbnails();
    initUrlStreamer();

    // ── Auto-save playback history for Continue Watching ───────────────────────
    let _lastSaveTime = 0;
    player.on("timeupdate", () => {
      if (!activeFilename) return;
      const now = Date.now();
      if (now - _lastSaveTime > 2000) {
        _lastSaveTime = now;
        saveHistory(activeFilename, player.currentTime(), player.duration());
        // Update card progress bar in library
        updateCardProgress(activeFilename, player.currentTime(), player.duration());
      }
    });

    // ── YouTube-like seeking: restart HLS from wherever the user scrubs ───────
    player.on("seeked", () => {
      if (!activeFilename) return;
      const position = player.currentTime() || 0;

      // If on a fully-ready full-file HLS cache, Video.js handles it natively.
      const src     = player.currentSrc() || "";
      const onHls   = src.includes("/api/hls/");
      const hlsFull = hlsState.get(activeFilename) === "ready";
      if (onHls && hlsFull) return;

      // Otherwise, restart ffmpeg from the seek position.
      // The first HLS segment is ready in ~1 s → hls-segment fires → switch.
      if (!currentVideoDir) return;
      pendingHlsSeek = { filename: activeFilename, position };

      fetch(
        `/api/hls/seek/${encodeURIComponent(activeFilename)}?videoDir=${encodeURIComponent(currentVideoDir)}&socketId=${encodeURIComponent(socket.id)}`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ position }),
        }
      ).then(r => r.json()).then(body => {
        if (!activeFilename) return;
        if (body.status === "ready" || body.status === "generating") {
          pendingHlsSeek = null;
          switchToHlsAt(activeFilename, position);
        }
        // status === "started" → wait for hls-segment event
      }).catch(() => { pendingHlsSeek = null; });
    });

function logClientError(message, extra = {}) {
  try {
    const err = typeof player !== "undefined" && player ? player.error() : null;
    fetch("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: extra.level || "error",
        message: message,
        filename: typeof activeFilename !== "undefined" ? activeFilename : "",
        code: err ? err.code : extra.code || null,
        src: typeof player !== "undefined" && player ? player.currentSrc() : "",
        ...extra
      })
    }).catch(() => {});
  } catch {}
}

    player.on("error", () => {
      const err = player.error();
      const src = player.currentSrc() || "";

      logClientError("Player playback error", { code: err?.code, errorMessage: err?.message });

      if (src.includes("/api/hls/") && activeFilename) {
        console.warn("HLS error, falling back to direct stream", err);
        try { player.error(null); } catch {}
        fallbackDirectPlay(activeFilename);
        return;
      }

      // If direct stream failed due to unsupported codec/format (code 3 or 4), auto-start HLS
      if ((err?.code === 3 || err?.code === 4 || err?.code === 2) && activeFilename) {
        showToast("⚡ Converting video for smooth mobile playback...");
        try { player.error(null); } catch {}
        fetch(`/api/hls/start/${encodeURIComponent(activeFilename)}?videoDir=${encodeURIComponent(currentVideoDir)}`, {
          method: "POST"
        }).catch(() => {});
        return;
      }

      const msgs = {
        1: "Playback aborted.",
        2: "Network error — check your connection.",
        3: "Video format requires conversion — starting HLS...",
        4: "Video format requires conversion — starting HLS...",
      };
      const text = (err && msgs[err.code]) || "Unknown playback error.";
      setNowPlaying("⚠ " + text);
      console.warn("Video.js error", err);
    });
  });
}


/* ═══════════════════════════════════════════════════════════════════════════
   §2  Socket.io events  (HLS progress + library changes)
   ═══════════════════════════════════════════════════════════════════════════ */

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
    if (row) row.innerHTML = `<span class="faststart-error">✖ ${esc(error)}</span>`;
  }
});


/* ═══════════════════════════════════════════════════════════════════════════
   §4  Tap / click seek overlays  (Netflix-style)
   ═══════════════════════════════════════════════════════════════════════════ */

const SEEK_S = 5;

/** Fire the pop+ripple animation on a tap icon. */
function animateTap(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("tap-anim");
  void el.offsetWidth; // force reflow so animation restarts cleanly
  el.classList.add("tap-anim");
  clearTimeout(el._tapTimer);
  el._tapTimer = setTimeout(() => el.classList.remove("tap-anim"), 800);
}

/** SVG icons used in the center play/pause tap zone. */
const SVG_PLAY  = `<svg viewBox="0 0 24 24" fill="white" width="52" height="52"><polygon points="5,3 19,12 5,21"/></svg>`;
const SVG_PAUSE = `<svg viewBox="0 0 24 24" fill="white" width="52" height="52"><rect x="4" y="3" width="5" height="18" rx="1"/><rect x="15" y="3" width="5" height="18" rx="1"/></svg>`;

function initTapOverlay() {
  const tapOverlay = document.getElementById("tapOverlay");
  if (tapOverlay && player && player.el()) {
    player.el().appendChild(tapOverlay);
  }

  let _tapCount = 0;
  let _tapTimer = null;
  let _tapZone = null;

  function triggerPlayPause() {
    if (!player) return;
    const tapPlayPause = document.getElementById("tapPlayPause");
    const willPlay = player.paused();

    if (willPlay) {
      player.play().catch(() => {});
    } else {
      player.pause();
    }

    if (tapPlayPause) {
      tapPlayPause.innerHTML = willPlay ? SVG_PLAY : SVG_PAUSE;
    }
    animateTap("tapIconCenter");
  }

  function handleTap(zone, e) {
    if (!activeFilename) return;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (_is2xActive || _was2xJustActive) {
      _was2xJustActive = false;
      stop2xSpeed();
      return;
    }

    _tapCount++;
    _tapZone = zone;

    clearTimeout(_tapTimer);
    _tapTimer = setTimeout(() => {
      if (_tapCount === 1) {
        // Single tap = Play / Pause
        triggerPlayPause();
      } else if (_tapCount >= 2) {
        // Double tap (twice) = Skip 5 seconds
        if (_tapZone === "left") {
          seek(-SEEK_S, false);
        } else if (_tapZone === "right") {
          seek(+SEEK_S, true);
        }
      }
      _tapCount = 0;
      _tapZone = null;
    }, 240);
  }

  // Left zone — single tap = Play/Pause, double tap = -5s
  document.getElementById("tapZoneLeft").addEventListener("click", (e) => {
    handleTap("left", e);
  });

  // Right zone — single tap = Play/Pause, double tap = +5s
  document.getElementById("tapZoneRight").addEventListener("click", (e) => {
    handleTap("right", e);
  });

  // ── Drag / scrub detection & 2x Speed Hold ─────────────────────────────────
  let _tapDownX = null;
  let _tapDownY = null;
  player.el().addEventListener("pointerdown", (e) => {
    if (e.target.closest(".vjs-control-bar")) return;
    _tapDownX = e.clientX;
    _tapDownY = e.clientY;

    clearTimeout(_hold2xTimer);
    _hold2xTimer = setTimeout(() => {
      start2xSpeed();
    }, 400);
  });

  player.el().addEventListener("pointerup", () => stop2xSpeed());
  player.el().addEventListener("pointerleave", () => stop2xSpeed());
  player.el().addEventListener("pointercancel", () => stop2xSpeed());

  // Center zone / Player click handler
  player.el().addEventListener("click", (e) => {
    if (!activeFilename) return;
    if (e.target.closest(".vjs-control-bar")) return;
    if (e.target.closest("#tapZoneLeft") || e.target.closest("#tapZoneRight")) return;

    if (_is2xActive || _was2xJustActive) {
      _was2xJustActive = false;
      stop2xSpeed();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (_tapDownX !== null) {
      const moved = Math.abs(e.clientX - _tapDownX) > 8 ||
                    Math.abs(e.clientY - _tapDownY) > 8;
      _tapDownX = _tapDownY = null;
      if (moved) return;
    }

    handleTap("center", e);
  }, true);
}

function seek(delta, isForward) {
  if (!player) return;
  const next = Math.min(Math.max((player.currentTime() || 0) + delta, 0), player.duration() || Infinity);
  player.currentTime(next);
  animateTap(isForward ? "tapIconRight" : "tapIconLeft");
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
const clearHlsBtn   = document.getElementById("clearHlsBtn");
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

/* ═══════════════════════════════════════════════════════════════════════════
   §1.5  Continue Watching History, Subtitles & 2x Speed
   ═══════════════════════════════════════════════════════════════════════════ */

const HISTORY_KEY = "localstream_history";

function getHistoryMap() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}"); }
  catch { return {}; }
}

function saveHistory(filename, currentTime, duration) {
  if (!filename || !duration || isNaN(duration)) return;
  const history = getHistoryMap();
  if (currentTime / duration > 0.95 || duration - currentTime < 10) {
    delete history[filename];
  } else if (currentTime > 5) {
    history[filename] = { time: Math.floor(currentTime), duration: Math.floor(duration), ts: Date.now() };
  }
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function getSavedTime(filename) {
  const history = getHistoryMap();
  return history[filename]?.time || 0;
}

function clearSavedTime(filename) {
  const history = getHistoryMap();
  delete history[filename];
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function updateCardProgress(filename, currentTime, duration) {
  const card = videoList?.querySelector(`[data-filename="${CSS.escape(filename)}"]`);
  if (!card || !duration) return;
  let bar = card.querySelector(".card-progress-bar");
  let fill = card.querySelector(".card-progress-fill");
  let timeLabel = card.querySelector(".card-resume-time");
  const pct = Math.min(100, Math.max(0, (currentTime / duration) * 100));
  if (pct > 1) {
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "card-progress-bar";
      fill = document.createElement("div");
      fill.className = "card-progress-fill";
      bar.appendChild(fill);
      card.appendChild(bar);
    }
    if (fill) fill.style.width = `${pct}%`;
    if (!timeLabel) {
      timeLabel = document.createElement("div");
      timeLabel.className = "card-resume-time";
      card.appendChild(timeLabel);
    }
    if (timeLabel) timeLabel.textContent = `Resume from ${formatTime(currentTime)}`;
  }
}


/* ── Subtitle Loader ───────────────────────────────────────────────────────── */
function srtToVtt(srtText) {
  let vtt = "WEBVTT\n\n" + srtText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  vtt = vtt.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
  return vtt;
}

function initSubtitleLoader() {
  const subInput = document.getElementById("subInput");
  if (!subInput) return;
  subInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file || !player) return;
    subInput.value = "";

    const reader = new FileReader();
    reader.onload = (event) => {
      let content = event.target.result;
      if (file.name.toLowerCase().endsWith(".srt")) {
        content = srtToVtt(content);
      }
      const blob = new Blob([content], { type: "text/vtt" });
      const url = URL.createObjectURL(blob);

      const tracks = player.remoteTextTracks();
      if (tracks) {
        for (let i = tracks.length - 1; i >= 0; i--) {
          player.removeRemoteTextTrack(tracks[i]);
        }
      }

      const track = player.addRemoteTextTrack({
        kind: "subtitles",
        src: url,
        srclang: "en",
        label: file.name.replace(/\.[^.]+$/, ""),
        default: true
      }, true);

      if (track && track.track) track.track.mode = "showing";
      renderSubtitleTracks();
      showToast(`💬 Subtitles loaded: ${file.name}`);
    };
    reader.readAsText(file);
  });
}

/* ── Player Settings Panel (Gear Icon) ─────────────────────────────────────── */
function toggleSettingsPanel() {
  const panel = document.getElementById("settingsPanel");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    renderAudioTracks();
    renderSubtitleTracks();
  }
}

function renderAudioTracks() {
  const container = document.getElementById("audioTrackList");
  if (!container || !player) return;
  container.innerHTML = "";

  const audioTracks = player.audioTracks ? player.audioTracks() : [];
  if (!audioTracks || audioTracks.length === 0) {
    container.innerHTML = `<div class="settings-option active">Default Audio Stream</div>`;
    return;
  }

  for (let i = 0; i < audioTracks.length; i++) {
    const track = audioTracks[i];
    const opt = document.createElement("div");
    opt.className = "settings-option" + (track.enabled ? " active" : "");
    opt.textContent = track.label || track.language || `Audio Track ${i + 1}`;
    opt.onclick = () => {
      for (let j = 0; j < audioTracks.length; j++) audioTracks[j].enabled = (i === j);
      renderAudioTracks();
      showToast(`🔊 Switched to ${opt.textContent}`);
    };
    container.appendChild(opt);
  }
}

function renderSubtitleTracks() {
  const container = document.getElementById("subtitleTrackList");
  if (!container || !player) return;
  container.innerHTML = "";

  const remoteTracks = player.remoteTextTracks ? player.remoteTextTracks() : [];
  let isAnyShowing = false;
  if (remoteTracks) {
    for (let i = 0; i < remoteTracks.length; i++) {
      if (remoteTracks[i].mode === "showing") isAnyShowing = true;
    }
  }

  const offOpt = document.createElement("div");
  offOpt.className = "settings-option" + (!isAnyShowing ? " active" : "");
  offOpt.textContent = "Off";
  offOpt.onclick = () => {
    if (remoteTracks) {
      for (let i = 0; i < remoteTracks.length; i++) remoteTracks[i].mode = "disabled";
    }
    renderSubtitleTracks();
    showToast("💬 Subtitles turned Off");
  };
  container.appendChild(offOpt);

  if (!remoteTracks || remoteTracks.length === 0) return;

  for (let i = 0; i < remoteTracks.length; i++) {
    const track = remoteTracks[i];
    if (track.kind !== "subtitles" && track.kind !== "captions") continue;
    const opt = document.createElement("div");
    opt.className = "settings-option" + (track.mode === "showing" ? " active" : "");
    opt.textContent = track.label || track.language || `Subtitle Track ${i + 1}`;
    opt.onclick = () => {
      for (let j = 0; j < remoteTracks.length; j++) {
        remoteTracks[j].mode = (remoteTracks[i] === remoteTracks[j]) ? "showing" : "disabled";
      }
      renderSubtitleTracks();
      showToast(`💬 Subtitles: ${opt.textContent}`);
    };
    container.appendChild(opt);
  }
}

function initSettingsMenu() {
  const closeBtn = document.getElementById("closeSettingsBtn");
  closeBtn?.addEventListener("click", () => {
    const panel = document.getElementById("settingsPanel");
    if (panel) panel.hidden = true;
  });

  const speedBtns = document.querySelectorAll(".speed-btn");
  speedBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const speed = parseFloat(btn.dataset.speed || "1.0");
      if (player) player.playbackRate(speed);
      speedBtns.forEach((b) => b.classList.toggle("active", b === btn));
      showToast(`⚡ Speed: ${speed}x`);
    });
  });

  // Close panel if clicked outside
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("settingsPanel");
    if (!panel || panel.hidden) return;
    if (!e.target.closest("#settingsPanel") && !e.target.closest(".vjs-settings-button")) {
      panel.hidden = true;
    }
  });
}

/* ── 2x Speed Hold Gesture ─────────────────────────────────────────────────── */
let _hold2xTimer = null;
let _is2xActive = false;
let _was2xJustActive = false;

function start2xSpeed() {
  if (_is2xActive || !player) return;
  _is2xActive = true;
  player.playbackRate(2.0);

  const badge = document.getElementById("speedBadge");
  if (badge) {
    badge.textContent = "Playing at 2x speed";
    badge.hidden = false;
    badge.style.display = "block";
  }
}

function stop2xSpeed() {
  clearTimeout(_hold2xTimer);
  _hold2xTimer = null;
  if (!_is2xActive) return;
  _is2xActive = false;
  _was2xJustActive = true;
  setTimeout(() => { _was2xJustActive = false; }, 300);

  if (player) {
    player.playbackRate(1.0);
    if (player.paused()) {
      player.play().catch(() => {});
    }
  }

  const badge = document.getElementById("speedBadge");
  if (badge) {
    badge.hidden = true;
    badge.style.display = "none";
  }
}

/* ── Direct Video / Stream URL Handler ──────────────────────────────────────── */
function initUrlStreamer() {
  const input = document.getElementById("streamUrlInput");
  const btn   = document.getElementById("streamUrlBtn");
  if (!input || !btn) return;

  function playUrl() {
    const rawUrl = (input.value || "").trim();
    if (!rawUrl || !player) return;

    try {
      const parsed = new URL(rawUrl);
      activeFilename = ""; // clear local file selection
      hidePlaceholder();

      const ext = parsed.pathname.split(".").pop()?.toLowerCase() || "";
      const isHls = ext === "m3u8" || rawUrl.includes(".m3u8");
      const mimeType = isHls ? "application/x-mpegURL" : "video/mp4";

      player.src({ src: rawUrl, type: mimeType });
      const urlName = parsed.pathname.split("/").pop() || parsed.hostname;
      setNowPlaying(`🌐 ${decodeURIComponent(urlName)}`);

      player.play().catch(() => {});
      showToast("▶ Streaming URL live");
    } catch {
      showToast("⚠ Invalid video URL");
    }
  }

  btn.addEventListener("click", playUrl);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      playUrl();
    }
  });
}

/* ── Progress Bar Hover Video Frame Thumbnail Preview (Zero-Lag Optimized) ──── */
let _previewVideo = null;
let _previewCanvas = null;
let _previewCtx = null;
let _previewCard = null;
let _previewTimeLabel = null;
let _isSeekingPreview = false;
const _frameCache = new Map();

function initProgressBarThumbnails() {
  if (!player) return;

  _previewVideo = document.createElement("video");
  _previewVideo.muted = true;
  _previewVideo.preload = "metadata";
  _previewVideo.playsInline = true;
  _previewVideo.style.display = "none";
  document.body.appendChild(_previewVideo);

  const progressControl = player.el().querySelector(".vjs-progress-control");
  if (!progressControl) return;

  _previewCard = document.createElement("div");
  _previewCard.className = "vjs-thumbnail-preview";
  _previewCard.style.display = "none";

  _previewCanvas = document.createElement("canvas");
  _previewCanvas.className = "vjs-thumbnail-canvas";
  _previewCanvas.width = 152;
  _previewCanvas.height = 85;
  _previewCtx = _previewCanvas.getContext("2d");

  _previewTimeLabel = document.createElement("div");
  _previewTimeLabel.className = "vjs-thumbnail-time";
  _previewTimeLabel.textContent = "0:00";

  _previewCard.appendChild(_previewCanvas);
  _previewCard.appendChild(_previewTimeLabel);
  progressControl.appendChild(_previewCard);

  player.on("loadstart", () => {
    _frameCache.clear();
    const src = player.currentSrc();
    if (src && _previewVideo) {
      _previewVideo.src = src;
    }
  });

  _previewVideo.addEventListener("seeked", () => {
    if (_previewCtx && _previewVideo && _previewVideo.readyState >= 2) {
      try {
        _previewCtx.drawImage(_previewVideo, 0, 0, _previewCanvas.width, _previewCanvas.height);
        const timeKey = Math.floor(_previewVideo.currentTime);
        if (_frameCache.size < 50) {
          createImageBitmap(_previewCanvas).then(bmp => _frameCache.set(timeKey, bmp)).catch(() => {});
        }
      } catch {}
    }
    _isSeekingPreview = false;
  });

  let _lastSeekTime = 0;
  let _hoverDebounceTimer = null;

  progressControl.addEventListener("mousemove", (e) => {
    const duration = player.duration();
    if (!duration || !isFinite(duration) || !_previewVideo) return;

    const rect = progressControl.getBoundingClientRect();
    const mouseX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const hoverPct = mouseX / rect.width;
    const hoverTime = hoverPct * duration;

    _previewCard.style.left = `${mouseX}px`;
    _previewCard.style.display = "flex";
    _previewTimeLabel.textContent = formatTime(hoverTime);

    const timeKey = Math.floor(hoverTime);
    if (_frameCache.has(timeKey)) {
      const bmp = _frameCache.get(timeKey);
      if (bmp && _previewCtx) {
        _previewCtx.drawImage(bmp, 0, 0, _previewCanvas.width, _previewCanvas.height);
      }
      return;
    }

    clearTimeout(_hoverDebounceTimer);
    _hoverDebounceTimer = setTimeout(() => {
      const now = Date.now();
      if (now - _lastSeekTime > 220 && !_isSeekingPreview) {
        _lastSeekTime = now;
        _isSeekingPreview = true;
        _previewVideo.currentTime = hoverTime;
      }
    }, 60);
  });

  progressControl.addEventListener("mouseleave", () => {
    if (_previewCard) _previewCard.style.display = "none";
    clearTimeout(_hoverDebounceTimer);
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

  const saved = getHistoryMap()[filename];
  const hasHistory = saved && saved.time > 5 && saved.duration > 0;
  const pct = hasHistory ? Math.min(100, Math.max(0, (saved.time / saved.duration) * 100)) : 0;

  li.innerHTML = `
    <div class="video-card-top">
      <span class="video-card-icon">${icons[ext] || "🎬"}</span>
      <div class="video-card-info">
        <div class="video-card-name" title="${esc(baseName)}">${esc(baseName)}</div>
        <div class="video-card-ext">${esc(ext.toUpperCase())}</div>
      </div>
    </div>
    ${hasHistory ? `
    <div class="card-progress-bar"><div class="card-progress-fill" style="width:${pct}%"></div></div>
    <div class="card-resume-time">Resume from ${formatTime(saved.time)}</div>` : ""}
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

let activeFilename  = null;
/** Last known video directory — stored so the seeked handler can call /api/hls/seek without a round-trip. */
let currentVideoDir = "";

/** Play a video on this screen only. */
function broadcastPlay(filename) {
  playViaServer(filename);
}

/* ═══════════════════════════════════════════════════════════════════════════
   HLS state — tracks in-progress and ready HLS jobs
   ═══════════════════════════════════════════════════════════════════════════ */

/** filename → "generating" | "ready" */
const hlsState = new Map();

/**
 * When the user seeks and we trigger a HLS seek-restart on the server,
 * this holds the exact player position we want to restore once the first
 * HLS segment is available.  null = no pending seek.
 */
let pendingHlsSeek = null;  // { filename, position }

/** Switch the currently-playing video to HLS, preserving playback position. */
function switchToHls(filename) {
  if (!player || filename !== activeFilename) return;
  const src = player.currentSrc() || "";
  if (src.includes("/api/hls/")) return; // already on HLS
  const hlsPath = `/api/hls/${encodeURIComponent(filename)}/index.m3u8`;
  const pos = player.currentTime() || 0;
  try { player.error(null); } catch {}
  player.src({ src: hlsPath, type: "application/x-mpegURL" });
  if (pos > 0.5) player.one("loadedmetadata", () => player.currentTime(pos));
  player.play().catch(() => {});
}

/**
 * Switch to HLS AND seek to a specific position.
 * Used after a seek-triggered HLS restart so the player resumes exactly
 * where the user scrubbed, not from the beginning of the new manifest.
 */
function switchToHlsAt(filename, position) {
  if (!player || filename !== activeFilename) return;
  const hlsPath = `/api/hls/${encodeURIComponent(filename)}/index.m3u8`;
  try { player.error(null); } catch {}
  player.src({ src: hlsPath, type: "application/x-mpegURL" });
  player.one("loadedmetadata", () => {
    player.currentTime(position);
    player.play().catch(() => {});
  });
  player.play().catch(() => {});
}

/**
 * HLS socket events:
 *  - hls-segment: fires each time a new .ts segment lands on disk.
 *    Once we have HLS_SWITCH_THRESHOLD segments, switch the live player
 *    from direct stream to HLS so buffering starts immediately.
 *  - hls-ready: full manifest written — update badge only (player already on HLS).
 */
socket.on("hls-segment", ({ filename, count, transcoding }) => {
  hlsState.set(filename, "generating");
  updateHlsCardState(filename, "generating", count, transcoding);

  // If a seek-triggered HLS restart is pending AND we have at least 1 segment
  // for the right file, the target position is now on disk → switch to HLS immediately.
  if (
    pendingHlsSeek &&
    pendingHlsSeek.filename === filename &&
    count >= 1
  ) {
    const { position } = pendingHlsSeek;
    pendingHlsSeek = null;
    switchToHlsAt(filename, position);
  }
});

socket.on("hls-ready", ({ filename }) => {
  hlsState.set(filename, "ready");
  updateHlsCardState(filename, "ready");
  // Full cache done — every segment is on disk, switch now for instant seeking.
  switchToHls(filename);
});

socket.on("hls-seek-ready", ({ filename }) => {
  // Seek-job finished (startAt > 0). Clear any stale pending seek.
  if (pendingHlsSeek?.filename === filename) pendingHlsSeek = null;
});

socket.on("hls-error", ({ filename, error }) => {
  hlsState.delete(filename);
  updateHlsCardState(filename, "error", 0, error);
  // Don't touch the player — direct streaming is already running fine
});

function fallbackDirectPlay(filename) {
  if (!player) return;
  const ext  = filename.split(".").pop().toLowerCase();
  const mime = { mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo", mov: "video/quicktime" };

  try { player.error(null); } catch {}
  player.src({ src: `/video/${encodeURIComponent(filename)}`, type: mime[ext] || "video/mp4" });
  player.play().catch(() => {});

  // For non-web formats (mkv, avi, flv, ts, wmv), auto-start HLS conversion in background
  if (["mkv", "avi", "flv", "ts", "wmv", "3gp"].includes(ext)) {
    fetch(`/api/hls/start/${encodeURIComponent(filename)}?videoDir=${encodeURIComponent(currentVideoDir)}`, {
      method: "POST"
    }).catch(() => {});
  }
}

function updateHlsCardState(filename, status, count, transcodingOrError, error) {
  const transcoding = (status === "generating" && transcodingOrError === true);
  if (status !== "generating") error = transcodingOrError;
  const card = videoList.querySelector(`[data-filename="${CSS.escape(filename)}"]`);
  if (!card) return;
  let row = card.querySelector(".hls-row");
  if (!row) {
    row = document.createElement("div");
    row.className = "hls-row";
    card.appendChild(row);
  }
  if (status === "generating") {
    const label = transcoding
      ? `⚙ Converting… seg ${count} (plays smooth next time)`
      : `⚡ Preparing… seg ${count}`;
    row.innerHTML = `<span class="hls-badge hls-loading">${label}</span>`;
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

  // Auto-resume from saved playback position if available
  const savedTime = getSavedTime(filename);
  if (savedTime > 5) {
    player.one("loadedmetadata", () => {
      if (activeFilename === filename && (player.currentTime() || 0) < 1) {
        player.currentTime(savedTime);
      }
    });
  }

  // Step 1 — always start direct streaming immediately so the video plays
  // right away with no waiting. This also shows the timer correctly.
  fallbackDirectPlay(filename);

  // Step 2 — in the background, ask the server to start (or check) HLS.
  // If HLS is already fully cached (has #EXT-X-ENDLIST), switch to it now
  // for chunk-preload buffering. Otherwise generation runs in the background
  // and will be used on the NEXT play of this file.
  try {
    const dirRes   = await fetch("/api/video-dir");
    const videoDir = dirRes.ok ? ((await dirRes.json()).path ?? "") : "";
    if (!videoDir) return;
    currentVideoDir = videoDir; // store for seek handler

    const hlsRes = await fetch(
      `/api/hls/start/${encodeURIComponent(filename)}?videoDir=${encodeURIComponent(videoDir)}&socketId=${encodeURIComponent(socket.id)}`,
      { method: "POST" }
    );
    if (!hlsRes.ok) return;

    const body = await hlsRes.json();

    if (body.status === "ready" && filename === activeFilename) {
      // Fully cached — every segment is on disk, switch now for instant seeking
      hlsState.set(filename, "ready");
      switchToHls(filename);
    } else if (body.status === "generating") {
      // Segments still building — stay on direct streaming (Range requests = instant seek).
      // The hls-ready socket event will switch us over once the full cache is done.
      hlsState.set(filename, "generating");
      updateHlsCardState(filename, "generating", body.segments ?? 0, body.transcoding);
    }
  } catch { /* network hiccup — direct stream keeps playing */ }
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

clearHlsBtn?.addEventListener("click", async () => {
  if (!confirm("Clear HLS cache? Videos will re-buffer on next play but black screen issues will be fixed.")) return;
  clearHlsBtn.disabled = true;
  clearHlsBtn.textContent = "⏳";
  try {
    const r = await fetch("/api/hls/clear", { method: "POST" });
    clearHlsBtn.textContent = r.ok ? "✓" : "✗";
  } catch {
    clearHlsBtn.textContent = "✗";
  }
  setTimeout(() => { clearHlsBtn.textContent = "🗑"; clearHlsBtn.disabled = false; }, 2000);
});

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
