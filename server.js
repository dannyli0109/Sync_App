const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const rooms = new Map();

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

app.use(express.json());

app.get('/api/bili/ticket', async (req, res) => {
  try {
    const upstreamUrl = new URL(
      'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket',
    );

    Object.entries(req.query).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((entry) => upstreamUrl.searchParams.append(key, entry));
      } else if (value != null) {
        upstreamUrl.searchParams.append(key, value);
      }
    });

    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36',
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
      },
    });

    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    const contentType = upstreamResponse.headers.get('content-type');

    if (contentType) {
      res.set('Content-Type', contentType);
    }

    res.status(upstreamResponse.status).send(buffer);
  } catch (error) {
    console.error('Failed to proxy Bilibili ticket request', error);
    res.status(502).json({
      error: 'ProxyError',
      message: 'Unable to reach Bilibili ticket endpoint.',
    });
  }
});

app.get('/api/rooms/new', (req, res) => {
  const roomId = nanoid(6);
  res.json({ roomId });
});

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, displayName }) => {
    if (!roomId || typeof roomId !== 'string') {
      return;
    }

    const trimmedId = roomId.trim();
    const room = ensureRoom(trimmedId);

    socket.data.roomId = trimmedId;
    socket.data.displayName = displayName || 'Guest';

    socket.join(trimmedId);
    room.participants.add(socket.id);

    if (!room.hostId) {
      setHost(room, socket.id);
    }

    socket.emit('room-init', {
      roomId: trimmedId,
      hostId: room.hostId,
      state: room.state,
      participantId: socket.id,
    });

    socket.to(trimmedId).emit('participant-joined', {
      participantId: socket.id,
      displayName: socket.data.displayName,
    });
  });

  socket.on('set-video', ({ bvid, startTime }) => {
    const room = getRoomForSocket(socket);
    if (!room || room.hostId !== socket.id) {
      return;
    }

    if (!bvid || typeof bvid !== 'string') {
      return;
    }

    const now = Date.now();
    room.state = {
      bvid: bvid.trim(),
      time: typeof startTime === 'number' ? Math.max(startTime, 0) : 0,
      paused: true,
      playbackRate: 1,
      updatedAt: now,
    };

    io.to(socket.data.roomId).emit('load-video', room.state);
  });

  socket.on('host-update', (payload) => {
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
    socket.to(socket.data.roomId).emit('sync-state', nextState);
  });

  socket.on('request-host', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;

    if (room.hostId === socket.id) {
      socket.emit('host-changed', { hostId: room.hostId });
      return;
    }

    setHost(room, socket.id);
    io.to(socket.data.roomId).emit('host-changed', {
      hostId: room.hostId,
    });

    if (room.state) {
      socket.emit('sync-state', room.state);
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
