const elements = {
  displayName: document.getElementById('displayName'),
  roomIdInput: document.getElementById('roomIdInput'),
  joinRoomButton: document.getElementById('joinRoomButton'),
  createRoomButton: document.getElementById('createRoomButton'),
  takeHostButton: document.getElementById('takeHostButton'),
  uploadVideoButton: document.getElementById('uploadVideoButton'),
  videoFileInput: document.getElementById('videoFileInput'),
  roomInfo: document.getElementById('roomInfo'),
  roomIdLabel: document.getElementById('roomIdLabel'),
  roleLabel: document.getElementById('roleLabel'),
  shareLink: document.getElementById('shareLink'),
  copyLinkButton: document.getElementById('copyLinkButton'),
  videoControls: document.getElementById('videoControls'),
  videoStatus: document.getElementById('videoStatus'),
  hostHint: document.getElementById('hostHint'),
  playerContainer: document.getElementById('playerContainer'),
  videoLibrary: document.getElementById('videoLibrary'),
  refreshLibraryButton: document.getElementById('refreshLibraryButton'),
  videoList: document.getElementById('videoList'),
  libraryStatus: document.getElementById('libraryStatus'),
};

const socket = io();
const SYNC_THRESHOLD = 0.35;
const HARD_DESYNC_THRESHOLD = 1.2;
const TIMEUPDATE_THROTTLE_MS = 250;
const RATE_ADJUST_STEP = 0.08;
const BASE_RATE_EPSILON = 0.01;

let activeRoomId = detectRoomFromLocation();
let isHost = false;
let currentVideoEl = null;
let currentVideoId = null;
let suppressHostEmission = false;
let ignoreViewerEvents = false;
let awaitingVideoReady = false;
let videoListeners = [];
let lastThrottle = 0;
let lastSyncedState = null;
let videoLibraryItems = [];
let libraryLoading = false;

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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function updateRoomUi(roomId) {
  if (!roomId) {
    elements.roomInfo.hidden = true;
    elements.videoControls.hidden = true;
    elements.videoLibrary.hidden = true;
    showVideoStatus('No video loaded yet.', 'info');
    return;
  }

  elements.roomInfo.hidden = false;
  elements.roomIdLabel.textContent = roomId;

  const shareUrl = `${window.location.origin}/room/${roomId}`;
  elements.shareLink.textContent = shareUrl;
  elements.shareLink.dataset.url = shareUrl;

  elements.videoControls.hidden = false;
  elements.videoLibrary.hidden = false;
}

function setRole(hostId) {
  const previousRole = isHost;
  isHost = Boolean(hostId) && socket.id === hostId;

  elements.roleLabel.textContent = isHost ? 'Host' : 'Viewer';
  elements.takeHostButton.disabled = isHost;
  elements.uploadVideoButton.disabled = !isHost;
  elements.videoFileInput.disabled = !isHost;
  elements.hostHint.textContent = isHost
    ? 'You are the host. Upload a video and control playback for everyone.'
    : 'You are a viewer. Ask for host or take control to manage playback.';
  updateVideoAccess();
  renderVideoLibrary(videoLibraryItems);

  if (previousRole !== isHost) {
    if (!isHost) {
      stopSyncLoop();
    } else {
      startSyncLoop();
      emitHostState('role-change');
    }
  }
}

function cleanupPlayer() {
  if (videoListeners.length && currentVideoEl) {
    videoListeners.forEach(({ type, handler }) => {
      currentVideoEl.removeEventListener(type, handler);
    });
    videoListeners = [];
  }

  if (currentVideoEl) {
    try {
      currentVideoEl.pause();
    } catch {
      // ignore
    }
    currentVideoEl.removeAttribute('src');
    currentVideoEl.load();
    currentVideoEl.remove();
  }

  currentVideoEl = null;
  currentVideoId = null;
  suppressHostEmission = false;
  ignoreViewerEvents = false;
  awaitingVideoReady = false;
  lastSyncedState = null;
  stopSyncLoop();
  delete elements.playerContainer.dataset.viewer;
  elements.playerContainer.innerHTML =
    '<div class="player-placeholder"><p>Select or create a room, then upload a video to get started.</p></div>';
  highlightSelectedVideo();
}

function ensureVideoElement() {
  if (currentVideoEl) return currentVideoEl;

  elements.playerContainer.innerHTML = '';
  const video = document.createElement('video');
  video.className = 'watch-video';
  video.controls = true;
  video.playsInline = true;
  video.preload = 'auto';
  elements.playerContainer.appendChild(video);
  currentVideoEl = video;
  setupVideoListeners(video);
  updateVideoAccess();
  return video;
}

function setupVideoListeners(video) {
  videoListeners.forEach(({ type, handler }) => {
    video.removeEventListener(type, handler);
  });

  const events = ['play', 'pause', 'seeking', 'ratechange', 'timeupdate'];
  videoListeners = events.map((type) => {
    const handler = (event) => handleVideoEvent(event);
    video.addEventListener(type, handler);
    return { type, handler };
  });
}

function handleVideoEvent(event) {
  if (!currentVideoEl || event.target !== currentVideoEl) return;

  if (!isHost) {
    if (ignoreViewerEvents || !lastSyncedState) return;
    ignoreViewerEvents = true;
    window.requestAnimationFrame(() => {
      applyRemoteState(lastSyncedState);
      window.setTimeout(() => {
        ignoreViewerEvents = false;
      }, 120);
    });
    return;
  }

  const throttle = event.type === 'timeupdate';
  emitHostState(event.type, { throttle });
}

function stopSyncLoop() { }

function startSyncLoop() { }

function emitHostState(reason, { throttle = false } = {}) {
  if (!isHost || suppressHostEmission || !currentVideoEl || !activeRoomId || !currentVideoId) {
    return;
  }

  if (throttle) {
    const now = performance.now();
    if (now - lastThrottle < TIMEUPDATE_THROTTLE_MS) return;
    lastThrottle = now;
  }

  const payload = {
    time: currentVideoEl.currentTime || 0,
    paused: currentVideoEl.paused,
    playbackRate: currentVideoEl.playbackRate || 1,
  };

  socket.emit('host-update', payload);
}

function applyRemoteState(state) {
  if (!state || awaitingVideoReady) return;

  lastSyncedState = state;

  if (!currentVideoEl || (state.videoId && state.videoId !== currentVideoId)) {
    loadVideo(state, { autoplay: !state.paused });
    return;
  }

  const desiredTime = typeof state.time === 'number' ? state.time : 0;
  const paused = Boolean(state.paused);
  const baseRate = state.playbackRate || 1;

  suppressHostEmission = true;
  ignoreViewerEvents = true;

  const currentTime = currentVideoEl.currentTime || 0;
  const diff = desiredTime - currentTime;
  const absDiff = Math.abs(diff);

  currentVideoEl.defaultPlaybackRate = baseRate;

  if (absDiff > HARD_DESYNC_THRESHOLD || paused) {
    try {
      currentVideoEl.currentTime = desiredTime;
    } catch {
      // ignore
    }
    if (Math.abs(currentVideoEl.playbackRate - baseRate) > BASE_RATE_EPSILON) {
      currentVideoEl.playbackRate = baseRate;
    }
  } else if (absDiff > SYNC_THRESHOLD) {
    const direction = diff > 0 ? 1 : -1;
    const adjusted = clamp(baseRate + direction * RATE_ADJUST_STEP, 0.5, 2);
    if (Math.abs(currentVideoEl.playbackRate - adjusted) > BASE_RATE_EPSILON) {
      currentVideoEl.playbackRate = adjusted;
    }
  } else if (Math.abs(currentVideoEl.playbackRate - baseRate) > BASE_RATE_EPSILON) {
    currentVideoEl.playbackRate = baseRate;
  }

  if (paused) {
    if (!currentVideoEl.paused) {
      currentVideoEl.pause();
    }
  } else if (currentVideoEl.paused) {
    currentVideoEl.play().catch(() => { });
  }

  updateVideoAccess();

  window.setTimeout(() => {
    if (!paused && Math.abs(currentVideoEl.playbackRate - baseRate) > BASE_RATE_EPSILON) {
      currentVideoEl.playbackRate = baseRate;
    }
    suppressHostEmission = false;
    ignoreViewerEvents = false;
  }, 150);
}

function loadVideo(state, options = {}) {
  if (!state || !state.videoUrl) return;

  lastSyncedState = state;
  currentVideoId = state.videoId || null;
  highlightSelectedVideo();

  const video = ensureVideoElement();
  awaitingVideoReady = true;
  ignoreViewerEvents = true;

  const sourceUrl = state.videoUrl;
  const autoplay = options.autoplay ?? !state.paused;
  const playbackRate = state.playbackRate || 1;

  const handleReady = () => {
    awaitingVideoReady = false;
    video.removeEventListener('error', handleError);

    suppressHostEmission = true;
    try {
      if (typeof state.time === 'number') {
        video.currentTime = state.time;
      }
    } catch {
      // ignore
    }

    video.defaultPlaybackRate = playbackRate;
    video.playbackRate = playbackRate;
    if (autoplay && !state.paused) {
      video.play().catch(() => { });
    } else if (state.paused) {
      video.pause();
    }

    updateVideoAccess();

    window.setTimeout(() => {
      suppressHostEmission = false;
      ignoreViewerEvents = false;
    }, 250);
  };

  const handleError = () => {
    awaitingVideoReady = false;
    suppressHostEmission = false;
    ignoreViewerEvents = false;
    video.removeEventListener('loadedmetadata', handleReady);
    showVideoStatus('Failed to load the video stream.', 'error');
  };

  video.addEventListener('loadedmetadata', handleReady, { once: true });
  video.addEventListener('error', handleError, { once: true });

  video.src = sourceUrl;
  video.load();
  updateVideoAccess();

  const label = state.videoName || 'Shared video';
  showVideoStatus(`Now playing: ${label}`, 'success');
}

function joinRoom(roomId) {
  if (!roomId) return;
  activeRoomId = roomId;
  cleanupPlayer();
  showVideoStatus('No video loaded yet.', 'info');
  setRole('');
  updateRoomUi(roomId);
  updateUrlForRoom(roomId);

  socket.emit('join-room', {
    roomId,
    displayName: elements.displayName.value.trim() || 'Guest',
  });
}

function showVideoStatus(message, tone = 'info') {
  if (!elements.videoStatus) return;
  elements.videoStatus.textContent = message;
  elements.videoStatus.dataset.state = tone;
}

function updateVideoAccess() {
  if (!currentVideoEl) {
    delete elements.playerContainer.dataset.viewer;
    return;
  }

  currentVideoEl.controls = true;
  currentVideoEl.classList.toggle('viewer-locked', !isHost && !!currentVideoId);
  currentVideoEl.tabIndex = 0;

  if (!currentVideoId) {
    delete elements.playerContainer.dataset.viewer;
    return;
  }

  elements.playerContainer.dataset.viewer = isHost ? 'free' : 'locked';
}

function highlightSelectedVideo() {
  if (!elements.videoList) return;
  const nodes = elements.videoList.querySelectorAll('[data-video-id]');
  nodes.forEach((node) => {
    const isActive = Boolean(currentVideoId && node.dataset.videoId === currentVideoId);
    node.classList.toggle('active', isActive);
    const button = node.querySelector('.video-select');
    if (button) {
      button.classList.toggle('active', isActive);
      button.disabled = !isHost;
    }
  });
}

function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTimestamp(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    hour12: false,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderVideoLibrary(items = []) {
  if (!elements.videoList || !elements.libraryStatus) return;
  videoLibraryItems = Array.isArray(items) ? items : [];
  elements.videoList.innerHTML = '';

  if (!videoLibraryItems.length) {
    elements.libraryStatus.hidden = false;
    elements.libraryStatus.dataset.state = libraryLoading ? 'info' : 'info';
    elements.libraryStatus.textContent = libraryLoading
      ? 'Loading videos...'
      : 'No videos uploaded yet.';
    highlightSelectedVideo();
    return;
  }

  elements.libraryStatus.hidden = true;

  const fragment = document.createDocumentFragment();
  videoLibraryItems.forEach((item) => {
    if (!item || !item.videoId) return;
    const listItem = document.createElement('li');
    listItem.className = 'video-item';
    listItem.dataset.videoId = item.videoId;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'video-select';
    button.dataset.videoId = item.videoId;
    button.disabled = !isHost;

    const title = document.createElement('span');
    title.className = 'video-title';
    title.textContent = item.originalName || item.videoId;

    const meta = document.createElement('span');
    meta.className = 'video-meta';
    const sizeLabel = formatFileSize(item.size);
    const timeLabel = formatTimestamp(item.lastModified);
    meta.textContent = [sizeLabel, timeLabel].filter(Boolean).join(' - ');

    button.appendChild(title);
    if (meta.textContent) {
      button.appendChild(meta);
    }

    listItem.appendChild(button);
    fragment.appendChild(listItem);
  });

  elements.videoList.appendChild(fragment);
  highlightSelectedVideo();
}

async function refreshVideoLibrary(showBusy = false) {
  if (!elements.videoLibrary || libraryLoading) return;
  libraryLoading = true;

  if (elements.libraryStatus) {
    if (!videoLibraryItems.length || showBusy) {
      elements.libraryStatus.hidden = false;
      elements.libraryStatus.dataset.state = 'info';
      elements.libraryStatus.textContent = showBusy
        ? 'Refreshing videos...'
        : 'Loading videos...';
    } else {
      elements.libraryStatus.hidden = true;
    }
  }

  try {
    const response = await fetch('/api/videos');
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];
    renderVideoLibrary(items);
    if (elements.libraryStatus) {
      if (!items.length) {
        elements.libraryStatus.hidden = false;
        elements.libraryStatus.dataset.state = 'info';
        elements.libraryStatus.textContent = 'No videos uploaded yet.';
      } else {
        elements.libraryStatus.hidden = true;
      }
    }
  } catch (error) {
    console.error('Failed to refresh video library', error);
    if (elements.libraryStatus) {
      elements.libraryStatus.hidden = false;
      elements.libraryStatus.dataset.state = 'error';
      elements.libraryStatus.textContent = 'Failed to load video library.';
    }
  } finally {
    libraryLoading = false;
  }
}

async function uploadVideo(file) {
  const presignResponse = await fetch('/api/videos/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
    }),
  });

  if (!presignResponse.ok) {
    let message = 'Failed to start upload.';
    try {
      const data = await presignResponse.json();
      if (data && data.message) message = data.message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const presignData = await presignResponse.json();
  if (!presignData || !presignData.uploadUrl || !presignData.videoId) {
    throw new Error('Upload signature response is invalid.');
  }

  const uploadHeaders = new Headers(presignData.headers || {});
  if (file.type && !uploadHeaders.has('Content-Type')) {
    uploadHeaders.set('Content-Type', file.type);
  }

  const uploadResponse = await fetch(presignData.uploadUrl, {
    method: 'PUT',
    headers: uploadHeaders,
    body: file,
  });

  if (!uploadResponse.ok) {
    let errorText = 'Upload to OSS failed.';
    try {
      errorText = await uploadResponse.text();
    } catch {
      // ignore parse failure
    }
    throw new Error(errorText || 'Upload to OSS failed.');
  }

  const finalizeResponse = await fetch(`/api/videos/${presignData.videoId}/complete`, {
    method: 'POST',
  });

  if (!finalizeResponse.ok) {
    let message = 'Failed to finalize upload.';
    try {
      const data = await finalizeResponse.json();
      if (data && data.message) message = data.message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  return finalizeResponse.json();
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
  } catch (error) {
    console.error('Failed to create room', error);
  }
});

elements.takeHostButton.addEventListener('click', () => {
  if (!activeRoomId) return;
  socket.emit('request-host');
});

elements.uploadVideoButton.addEventListener('click', async () => {
  if (!isHost) return;

  const file = elements.videoFileInput.files && elements.videoFileInput.files[0];
  if (!file) {
    showVideoStatus('Choose a video file first.', 'error');
    return;
  }

  try {
    elements.uploadVideoButton.disabled = true;
    elements.videoFileInput.disabled = true;
    showVideoStatus(`Uploading ${file.name}...`, 'info');

    const data = await uploadVideo(file);
    await refreshVideoLibrary();
    elements.videoFileInput.value = '';
    showVideoStatus(`Uploaded: ${data.originalName}`, 'success');
    socket.emit('set-video', { videoId: data.videoId, startTime: 0 });
  } catch (error) {
    showVideoStatus(error.message || 'Upload failed.', 'error');
    console.error('Upload failed', error);
  } finally {
    elements.uploadVideoButton.disabled = !isHost;
    elements.videoFileInput.disabled = !isHost;
  }
});

elements.refreshLibraryButton.addEventListener('click', () => {
  refreshVideoLibrary(true);
});

elements.videoList.addEventListener('click', (event) => {
  const button = event.target.closest('.video-select');
  if (!button || !button.dataset.videoId) return;
  if (!isHost) {
    showVideoStatus('Only the host can load a shared video.', 'error');
    return;
  }
  socket.emit('set-video', { videoId: button.dataset.videoId, startTime: 0 });
});

elements.copyLinkButton.addEventListener('click', async () => {
  const url = elements.shareLink.dataset.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    elements.copyLinkButton.textContent = 'Copied!';
    window.setTimeout(() => {
      elements.copyLinkButton.textContent = 'Copy';
    }, 1600);
  } catch (error) {
    console.error('Clipboard copy failed', error);
  }
});

if (activeRoomId) {
  elements.roomIdInput.value = activeRoomId;
  joinRoom(activeRoomId);
}

refreshVideoLibrary();
