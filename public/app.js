const BILI_CORE_URL = 'https://s1.hdslb.com/bfs/static/player/main/core.6dcbfdb4.js';

const elements = {
  displayName: document.getElementById('displayName'),
  roomIdInput: document.getElementById('roomIdInput'),
  joinRoomButton: document.getElementById('joinRoomButton'),
  createRoomButton: document.getElementById('createRoomButton'),
  takeHostButton: document.getElementById('takeHostButton'),
  loadVideoButton: document.getElementById('loadVideoButton'),
  videoInput: document.getElementById('videoInput'),
  roomInfo: document.getElementById('roomInfo'),
  roomIdLabel: document.getElementById('roomIdLabel'),
  roleLabel: document.getElementById('roleLabel'),
  shareLink: document.getElementById('shareLink'),
  copyLinkButton: document.getElementById('copyLinkButton'),
  videoControls: document.getElementById('videoControls'),
  hostHint: document.getElementById('hostHint'),
  playerContainer: document.getElementById('playerContainer'),
};

const socket = io();

let activeRoomId = detectRoomFromLocation();
let isHost = false;
let currentPlayer = null;
let currentVideoEl = null;
let currentBvid = null;
let suppressHostEmission = false;
let syncLoop = null;
let awaitingVideoReady = false;
let videoListeners = [];

function detectRoomFromLocation() {
  const pathMatch = window.location.pathname.match(/\/room\/([A-Za-z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];
  const params = new URLSearchParams(window.location.search);
  return params.get('room') || null;
}

function updateUrlForRoom(roomId) {
  const nextUrl = `${window.location.origin}/room/${roomId}`;
  window.history.replaceState({}, '', nextUrl);
}

function updateRoomUi(roomId) {
  if (!roomId) {
    elements.roomInfo.hidden = true;
    elements.videoControls.hidden = true;
    return;
  }

  elements.roomInfo.hidden = false;
  elements.roomIdLabel.textContent = roomId;

  const shareUrl = `${window.location.origin}/room/${roomId}`;
  elements.shareLink.textContent = shareUrl;
  elements.shareLink.dataset.url = shareUrl;

  elements.videoControls.hidden = false;
}

function setRole(hostId) {
  const previousRole = isHost;
  isHost = socket.id === hostId;

  elements.roleLabel.textContent = isHost ? 'Host' : 'Viewer';
  elements.takeHostButton.disabled = isHost;
  elements.loadVideoButton.disabled = !isHost;
  elements.hostHint.textContent = isHost
    ? 'You are host. Load a video and control playback for everyone.'
    : 'You are a viewer. Ask for host or take control to manage playback.';

  if (previousRole !== isHost) {
    if (!isHost) {
      stopSyncLoop();
    } else {
      startSyncLoop();
      emitHostState('role-change');
    }
  }
}

function ensureBiliCore() {
  if (window.nano) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = BILI_CORE_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error('Failed to load Bilibili player assets.'));
    document.head.appendChild(script);
  });
}

function cleanupPlayer() {
  if (videoListeners.length && currentVideoEl) {
    videoListeners.forEach(({ type, handler }) => {
      currentVideoEl.removeEventListener(type, handler);
    });
    videoListeners = [];
  }

  if (currentPlayer) {
    if (typeof currentPlayer.destroy === 'function') {
      currentPlayer.destroy();
    } else if (typeof currentPlayer.dispose === 'function') {
      currentPlayer.dispose();
    }
  }

  currentPlayer = null;
  currentVideoEl = null;
  stopSyncLoop();
}

async function loadVideo(state, options = {}) {
  if (!state || !state.bvid) return;
  currentBvid = state.bvid;

  cleanupPlayer();
  awaitingVideoReady = true;
  elements.playerContainer.innerHTML = '';

  await ensureBiliCore();

  window.__NanoStaticHttpKey = true;
  window.__NanoEmbedRefer = true;

  const config = {
    element: elements.playerContainer,
    bvid: state.bvid,
    autoplay: Boolean(options.autoplay),
    t: typeof state.time === 'number' ? Math.max(state.time, 0) : 0,
    muted: options.startMuted ?? false,
    danmaku: false,
    controlsList: new Set(['noScreenWide', 'noScreenWeb']),
  };

  currentPlayer = window.nano.createPlayer(config);
  currentPlayer.connect();

  const attach = () => {
    const video = currentPlayer?.getVideoElement?.();
    if (!video) return false;
    currentVideoEl = video;
    setupVideoListeners(video);
    awaitingVideoReady = false;
    if (isHost) {
      startSyncLoop();
      emitHostState('video-loaded');
    } else {
      applyRemoteState(state);
    }
    return true;
  };

  if (!attach()) {
    const waitId = window.setInterval(() => {
      if (attach()) {
        window.clearInterval(waitId);
      }
    }, 200);
    window.setTimeout(() => {
      window.clearInterval(waitId);
      awaitingVideoReady = false;
    }, 8000);
  }
}

function setupVideoListeners(video) {
  const handlers = [
    {
      type: 'play',
      handler: () => emitHostState('play'),
    },
    {
      type: 'pause',
      handler: () => emitHostState('pause'),
    },
    {
      type: 'seeking',
      handler: () => emitHostState('seeking'),
    },
    {
      type: 'ratechange',
      handler: () => emitHostState('ratechange'),
    },
    {
      type: 'timeupdate',
      handler: () => emitHostState('timeupdate', { throttle: true }),
    },
  ];

  handlers.forEach(({ type, handler }) => {
    video.addEventListener(type, handler);
  });

  videoListeners = handlers;
}

function stopSyncLoop() {
  if (syncLoop) {
    window.clearInterval(syncLoop);
    syncLoop = null;
  }
}

function startSyncLoop() {
  stopSyncLoop();
  if (!isHost) return;
  syncLoop = window.setInterval(() => emitHostState('interval'), 1500);
}

let lastThrottle = 0;

function emitHostState(reason, { throttle = false } = {}) {
  if (!isHost || suppressHostEmission || !currentVideoEl || !activeRoomId) {
    return;
  }

  if (throttle) {
    const now = performance.now();
    if (now - lastThrottle < 800) return;
    lastThrottle = now;
  }

  const payload = {
    bvid: currentBvid,
    time: currentVideoEl.currentTime || 0,
    paused: currentVideoEl.paused,
    playbackRate: currentVideoEl.playbackRate || 1,
  };

  socket.emit('host-update', payload);
}

function applyRemoteState(state) {
  if (!state || awaitingVideoReady) {
    return;
  }

  if (state.bvid && state.bvid !== currentBvid) {
    loadVideo(state, { autoplay: !state.paused });
    return;
  }

  if (!currentVideoEl || !currentPlayer) return;

  const desiredTime = typeof state.time === 'number' ? state.time : 0;
  const paused = Boolean(state.paused);
  const playbackRate = state.playbackRate || 1;

  suppressHostEmission = true;

  const adjustAfter = () => {
    window.setTimeout(() => {
      suppressHostEmission = false;
    }, 400);
  };

  if (Math.abs(currentVideoEl.currentTime - desiredTime) > 0.6) {
    if (typeof currentPlayer.seek === 'function') {
      currentPlayer
        .seek(desiredTime)
        .then(adjustAfter)
        .catch(adjustAfter);
    } else {
      currentVideoEl.currentTime = desiredTime;
      adjustAfter();
    }
  } else {
    adjustAfter();
  }

  if (currentVideoEl.playbackRate !== playbackRate) {
    currentVideoEl.playbackRate = playbackRate;
  }

  if (paused && !currentVideoEl.paused) {
    currentVideoEl.pause();
  } else if (!paused && currentVideoEl.paused) {
    currentVideoEl.play().catch(() => {});
  }
}

function extractBvid(input) {
  if (!input) return null;
  const match = input.trim().match(/BV[0-9A-Za-z]{5,}/i);
  return match ? match[0] : null;
}

function joinRoom(roomId) {
  if (!roomId) return;
  activeRoomId = roomId;
  currentBvid = null;
  cleanupPlayer();
  setRole('');
  updateRoomUi(roomId);
  updateUrlForRoom(roomId);
  socket.emit('join-room', {
    roomId,
    displayName: elements.displayName.value.trim() || 'Guest',
  });
}

// Socket events
socket.on('connect', () => {
  if (activeRoomId) {
    joinRoom(activeRoomId);
  }
});

socket.on('room-init', (payload) => {
  const { roomId, hostId, state } = payload;
  activeRoomId = roomId;
  elements.roomIdInput.value = roomId;
  updateRoomUi(roomId);
  setRole(hostId);
  if (state) {
    loadVideo(state, { autoplay: !state.paused });
  }
});

socket.on('load-video', (state) => {
  loadVideo(state, { autoplay: isHost ? true : !state.paused });
});

socket.on('sync-state', (state) => {
  if (isHost) return;
  applyRemoteState(state);
});

socket.on('host-changed', ({ hostId }) => {
  setRole(hostId);
});

// UI events
elements.joinRoomButton.addEventListener('click', () => {
  const roomId = elements.roomIdInput.value.trim();
  if (!roomId) return;
  joinRoom(roomId);
});

elements.createRoomButton.addEventListener('click', async () => {
  try {
    const response = await fetch('/api/rooms/new');
    const data = await response.json();
    if (data.roomId) {
      elements.roomIdInput.value = data.roomId;
      joinRoom(data.roomId);
    }
  } catch (err) {
    console.error('Failed to create room', err);
  }
});

elements.takeHostButton.addEventListener('click', () => {
  if (!activeRoomId) return;
  socket.emit('request-host');
});

elements.loadVideoButton.addEventListener('click', () => {
  if (!isHost) return;
  const inputValue = elements.videoInput.value;
  const bvid = extractBvid(inputValue);
  if (!bvid) {
    elements.videoInput.classList.add('input-error');
    window.setTimeout(
      () => elements.videoInput.classList.remove('input-error'),
      1200,
    );
    return;
  }

  socket.emit('set-video', { bvid, startTime: 0 });
});

elements.copyLinkButton.addEventListener('click', async () => {
  const url = elements.shareLink.dataset.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    elements.copyLinkButton.textContent = 'Copied!';
    window.setTimeout(
      () => (elements.copyLinkButton.textContent = 'Copy'),
      1600,
    );
  } catch (err) {
    console.error('Clipboard copy failed', err);
  }
});

if (activeRoomId) {
  elements.roomIdInput.value = activeRoomId;
  joinRoom(activeRoomId);
}
