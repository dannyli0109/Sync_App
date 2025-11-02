const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const OSS = require('ali-oss');
const { nanoid } = require('nanoid');

const app = express();
const server = createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_SIZE_BYTES = Number(
  process.env.MAX_UPLOAD_SIZE_BYTES || 1024 * 1024 * 1024,
);
const OSS_UPLOAD_EXPIRY_SECONDS = Math.max(
  Number(process.env.OSS_UPLOAD_EXPIRY_SECONDS) || 120,
  30,
);
const OSS_PLAYBACK_EXPIRY_SECONDS = Math.max(
  Number(process.env.OSS_PLAYBACK_EXPIRY_SECONDS) || 3600,
  60,
);
const OSS_VIDEO_PREFIX = ensureTrailingSlash(
  process.env.OSS_VIDEO_PREFIX || 'videos/',
);

const ossConfig = {
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET,
  region: process.env.OSS_REGION,
  endpoint: process.env.OSS_ENDPOINT,
  secure: process.env.OSS_SECURE === 'false' ? false : true,
};
console.log('OSS Config:', ossConfig);

let ossClient = null;

const rooms = new Map();
const videos = new Map();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function ensureRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      hostId: null,
      participants: new Set(),
      state: null,
    };
    rooms.set(roomId, room);
  }
  return room;
}

function getRoomForSocket(socket) {
  const { roomId } = socket.data;
  if (!roomId) return null;
  return rooms.get(roomId) || null;
}

function setHost(room, newHostId) {
  room.hostId = newHostId;
}

function ensureTrailingSlash(value) {
  if (!value) return '';
  const trimmed = value.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  return trimmed ? `${trimmed}/` : '';
}

function isOssConfigured() {
  return Boolean(
    ossConfig.accessKeyId &&
    ossConfig.accessKeySecret &&
    ossConfig.bucket &&
    (ossConfig.region || ossConfig.endpoint),
  );
}

function getOssClient() {
  if (!isOssConfigured()) {
    return null;
  }
  if (!ossClient) {
    const baseConfig = {
      accessKeyId: ossConfig.accessKeyId,
      accessKeySecret: ossConfig.accessKeySecret,
      bucket: ossConfig.bucket,
      secure: ossConfig.secure,
    };
    if (ossConfig.endpoint) {
      baseConfig.endpoint = ossConfig.endpoint;
    } else {
      baseConfig.region = ossConfig.region;
    }
    ossClient = new OSS(baseConfig);
  }
  return ossClient;
}

function respondOssNotConfigured(res) {
  res.status(503).json({
    error: 'OssNotConfigured',
    message:
      'Aliyun OSS credentials are missing. Set OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, and OSS_REGION or OSS_ENDPOINT.',
  });
}

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') {
    return 'video';
  }
  return name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-180) || 'video';
}

function buildObjectKey(videoId, originalName) {
  const cleaned = sanitizeFilename(originalName);
  const encoded = encodeURIComponent(cleaned);
  return `${OSS_VIDEO_PREFIX}${videoId}/${encoded}`;
}

function parseObjectKey(objectKey) {
  if (!objectKey || !objectKey.startsWith(OSS_VIDEO_PREFIX)) {
    return null;
  }
  const remainder = objectKey.slice(OSS_VIDEO_PREFIX.length);
  const slashIndex = remainder.indexOf('/');
  if (slashIndex <= 0) {
    return null;
  }
  const videoId = remainder.slice(0, slashIndex);
  const encodedName = remainder.slice(slashIndex + 1);
  if (!encodedName) {
    return null;
  }
  let originalName = encodedName;
  try {
    originalName = decodeURIComponent(encodedName);
  } catch {
    // Fallback to encodedName if decoding fails.
  }
  return {
    videoId,
    originalName,
    objectKey,
  };
}

function normalizeEtag(etag) {
  if (!etag) return null;
  return etag.replace(/^"+|"+$/g, '');
}

async function createPlaybackUrl(objectKey) {
  const client = getOssClient();
  if (!client) {
    throw new Error('OSS client not configured');
  }
  const expiresAt = Date.now() + OSS_PLAYBACK_EXPIRY_SECONDS * 1000;
  const url = client.signatureUrl(objectKey, {
    method: 'GET',
    expires: OSS_PLAYBACK_EXPIRY_SECONDS,
  });
  return { url, expiresAt };
}

async function ensurePlaybackUrl(state) {
  if (!state || !state.ossKey) {
    return state;
  }
  const now = Date.now();
  const bufferMs = 60 * 1000;
  if (!state.playbackExpiresAt || now >= state.playbackExpiresAt - bufferMs) {
    try {
      const playback = await createPlaybackUrl(state.ossKey);
      state.videoUrl = playback.url;
      state.playbackExpiresAt = playback.expiresAt;
    } catch (error) {
      console.error('Failed to refresh playback URL', error);
    }
  }
  return state;
}

function presentState(state) {
  if (!state) return null;
  const {
    ossKey: _ossKey,
    playbackExpiresAt: _playbackExpiresAt,
    ...publicState
  } = state;
  return publicState;
}

async function prepareStateForClient(state) {
  if (!state) return null;
  await ensurePlaybackUrl(state);
  return presentState(state);
}

async function resolveVideoRecord(videoId) {
  if (!videoId) {
    return null;
  }

  const cached = videos.get(videoId);
  if (cached && cached.status === 'ready') {
    return cached;
  }

  const client = getOssClient();
  if (!client) {
    return null;
  }

  let objectKey = cached && cached.objectKey;
  let originalName = cached && cached.originalName;

  try {
    if (!objectKey) {
      const prefix = `${OSS_VIDEO_PREFIX}${videoId}/`;
      const listResponse = await client.list({
        prefix,
        'max-keys': 1,
      });
      const [object] = listResponse.objects || [];
      if (!object || !object.name) {
        return null;
      }
      objectKey = object.name;
      const parsed = parseObjectKey(objectKey);
      if (!parsed) {
        return null;
      }
      originalName = parsed.originalName;
    }

    const headResponse = await client.head(objectKey);
    const headers = (headResponse && headResponse.res && headResponse.res.headers) || {};
    const record = {
      id: videoId,
      objectKey,
      originalName: originalName || sanitizeFilename('video'),
      mimeType: headers['content-type'] || (cached && cached.mimeType) || 'application/octet-stream',
      size: Number(headers['content-length'] || (cached && cached.size) || 0),
      lastModified: new Date(
        headers['last-modified'] || (cached && cached.lastModified) || Date.now(),
      ).getTime(),
      etag: normalizeEtag(headers.etag || (cached && cached.etag)),
      status: 'ready',
      uploadedAt: Date.now(),
    };
    videos.set(videoId, record);
    return record;
  } catch (error) {
    if (error && error.code === 'NoSuchKey') {
      return null;
    }
    console.error(`Failed to resolve video ${videoId} from OSS`, error);
    return null;
  }
}

app.post('/api/videos/presign', async (req, res) => {
  if (!isOssConfigured()) {
    return respondOssNotConfigured(res);
  }

  const { originalName, contentType, sizeBytes } = req.body || {};

  if (sizeBytes && Number(sizeBytes) > MAX_UPLOAD_SIZE_BYTES) {
    return res.status(413).json({
      error: 'UploadTooLarge',
      message: 'The video exceeds the configured upload size limit.',
    });
  }

  const safeName = sanitizeFilename(originalName || 'video');
  const mimeType = typeof contentType === 'string' && contentType ? contentType : 'application/octet-stream';
  const size = Number(sizeBytes) || null;

  const client = getOssClient();
  if (!client) {
    return respondOssNotConfigured(res);
  }

  const videoId = nanoid(12);
  const objectKey = buildObjectKey(videoId, safeName);
  const headers = {};
  if (mimeType) {
    headers['Content-Type'] = mimeType;
  }

  let uploadUrl;
  try {
    uploadUrl = client.signatureUrl(objectKey, {
      method: 'PUT',
      expires: OSS_UPLOAD_EXPIRY_SECONDS,
      headers,
    });
  } catch (error) {
    console.error('Failed to generate OSS upload signature', error);
    return res.status(500).json({
      error: 'SignatureFailed',
      message: 'Failed to generate upload signature.',
    });
  }

  const expiresAt = new Date(Date.now() + OSS_UPLOAD_EXPIRY_SECONDS * 1000).toISOString();

  videos.set(videoId, {
    id: videoId,
    objectKey,
    originalName: safeName,
    mimeType,
    size,
    createdAt: Date.now(),
    status: 'pending',
  });

  res.json({
    videoId,
    objectKey,
    uploadUrl,
    expiresAt,
    headers,
  });
});

app.post('/api/videos/:id/complete', async (req, res) => {
  if (!isOssConfigured()) {
    return respondOssNotConfigured(res);
  }

  const { id } = req.params;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({
      error: 'InvalidVideoId',
      message: 'Video ID is required.',
    });
  }

  const record = await resolveVideoRecord(id);
  if (!record) {
    return res.status(404).json({
      error: 'VideoNotFound',
      message: 'Uploaded video not found in OSS.',
    });
  }

  videos.set(id, record);

  try {
    const playback = await createPlaybackUrl(record.objectKey);
    res.json({
      videoId: record.id,
      videoUrl: playback.url,
      expiresAt: new Date(playback.expiresAt).toISOString(),
      originalName: record.originalName,
      size: record.size,
      mimeType: record.mimeType,
    });
  } catch (error) {
    console.error('Failed to generate playback URL during completion', error);
    res.status(500).json({
      error: 'PlaybackUrlFailed',
      message: 'Failed to generate playback URL.',
    });
  }
});

app.get('/api/videos', async (req, res) => {
  if (!isOssConfigured()) {
    return res.json({ items: [] });
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const client = getOssClient();
  const items = [];
  let marker;

  try {
    while (items.length < limit) {
      const response = await client.list({
        prefix: OSS_VIDEO_PREFIX,
        marker,
        'max-keys': Math.min(limit - items.length, 200),
      });
      const objects = response.objects || [];
      for (const object of objects) {
        if (!object || !object.name || object.name.endsWith('/')) {
          continue;
        }
        const parsed = parseObjectKey(object.name);
        if (!parsed) {
          continue;
        }
        const cached = videos.get(parsed.videoId);
        const item = cached && cached.status === 'ready'
          ? cached
          : {
            id: parsed.videoId,
            objectKey: object.name,
            originalName: parsed.originalName,
            size: Number(object.size) || null,
            lastModified: new Date(object.lastModified || Date.now()).getTime(),
            mimeType: (cached && cached.mimeType) || 'application/octet-stream',
            status: 'ready',
          };
        videos.set(parsed.videoId, item);
        items.push({
          videoId: item.id,
          originalName: item.originalName,
          size: item.size,
          lastModified: item.lastModified,
        });
        if (items.length >= limit) {
          break;
        }
      }
      if (!response.isTruncated || items.length >= limit) {
        break;
      }
      marker = response.nextMarker;
    }
  } catch (error) {
    console.error('Failed to list videos from OSS', error);
    return res.status(500).json({
      error: 'ListFailed',
      message: 'Failed to list videos from OSS.',
    });
  }

  res.json({ items });
});

app.get('/api/videos/:id/playback', async (req, res) => {
  if (!isOssConfigured()) {
    return respondOssNotConfigured(res);
  }

  const { id } = req.params;
  const record = await resolveVideoRecord(id);
  if (!record) {
    return res.status(404).json({
      error: 'VideoNotFound',
      message: 'Video not found.',
    });
  }

  try {
    const playback = await createPlaybackUrl(record.objectKey);
    res.json({
      videoId: record.id,
      videoUrl: playback.url,
      expiresAt: new Date(playback.expiresAt).toISOString(),
      originalName: record.originalName,
      size: record.size,
      mimeType: record.mimeType,
    });
  } catch (error) {
    console.error('Failed to generate playback URL', error);
    res.status(500).json({
      error: 'PlaybackUrlFailed',
      message: 'Failed to generate playback URL.',
    });
  }
});

app.get('/api/rooms/new', (req, res) => {
  const roomId = nanoid(6);
  res.json({ roomId });
});

io.on('connection', (socket) => {
  socket.on('join-room', async ({ roomId, displayName }) => {
    if (!roomId || typeof roomId !== 'string') {
      return;
    }

    const trimmedId = roomId.trim();
    if (!trimmedId) {
      return;
    }

    const room = ensureRoom(trimmedId);

    socket.data.roomId = trimmedId;
    socket.data.displayName = displayName || 'Guest';

    socket.join(trimmedId);
    room.participants.add(socket.id);

    if (!room.hostId) {
      setHost(room, socket.id);
    }

    const state = await prepareStateForClient(room.state);

    socket.emit('room-init', {
      roomId: trimmedId,
      hostId: room.hostId,
      state,
      participantId: socket.id,
    });

    socket.to(trimmedId).emit('participant-joined', {
      participantId: socket.id,
      displayName: socket.data.displayName,
    });
  });

  socket.on('set-video', async ({ videoId, startTime }) => {
    const room = getRoomForSocket(socket);
    if (!room || room.hostId !== socket.id) {
      return;
    }

    if (!videoId || typeof videoId !== 'string') {
      return;
    }

    const record = await resolveVideoRecord(videoId);
    if (!record) {
      return;
    }

    try {
      const playback = await createPlaybackUrl(record.objectKey);
      const now = Date.now();
      room.state = {
        videoId: record.id,
        videoUrl: playback.url,
        videoName: record.originalName,
        size: record.size,
        time: typeof startTime === 'number' ? Math.max(startTime, 0) : 0,
        paused: true,
        playbackRate: 1,
        updatedAt: now,
        ossKey: record.objectKey,
        playbackExpiresAt: playback.expiresAt,
      };
      io.to(socket.data.roomId).emit('load-video', presentState(room.state));
    } catch (error) {
      console.error('Failed to set video for room', error);
    }
  });

  socket.on('host-update', async (payload) => {
    const room = getRoomForSocket(socket);
    if (!room || room.hostId !== socket.id || !room.state) {
      return;
    }

    const nextState = {
      ...room.state,
      ...payload,
      updatedAt: Date.now(),
    };

    room.state = nextState;
    socket.to(socket.data.roomId).emit('sync-state', presentState(nextState));
  });

  socket.on('request-host', async () => {
    const room = getRoomForSocket(socket);
    if (!room) {
      return;
    }

    if (room.hostId === socket.id) {
      socket.emit('host-changed', { hostId: room.hostId });
      return;
    }

    setHost(room, socket.id);
    io.to(socket.data.roomId).emit('host-changed', {
      hostId: room.hostId,
    });

    if (room.state) {
      await ensurePlaybackUrl(room.state);
      socket.emit('sync-state', presentState(room.state));
    }
  });

  socket.on('disconnect', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;

    room.participants.delete(socket.id);
    socket.to(socket.data.roomId).emit('participant-left', {
      participantId: socket.id,
    });

    if (room.hostId === socket.id) {
      const [nextHostId] = room.participants;
      if (nextHostId) {
        setHost(room, nextHostId);
        io.to(socket.data.roomId).emit('host-changed', {
          hostId: room.hostId,
        });
        if (room.state) {
          ensurePlaybackUrl(room.state).then(() => {
            io.to(socket.data.roomId).emit(
              'sync-state',
              presentState(room.state),
            );
          });
        }
      } else {
        rooms.delete(socket.data.roomId);
      }
    }
  });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
