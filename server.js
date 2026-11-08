const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const HOST = '0.0.0.0';

const rooms = new Map();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let roomId = '';
  for (let i = 0; i < 6; i += 1) {
    roomId += chars[Math.floor(Math.random() * chars.length)];
  }
  return roomId;
}

function sanitizeName(name) {
  const safe = String(name || '').trim();
  if (!safe) {
    return 'Guest';
  }
  return safe.slice(0, 24);
}

function sanitizeRoomId(value) {
  if (!value) {
    return '';
  }
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function defaultPlaybackState() {
  return {
    url: '',
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    state: 'idle',
    lastUpdated: Date.now()
  };
}

function createRoom(roomId) {
  const newRoom = {
    id: roomId,
    hostSocketId: null,
    participants: new Map(),
    messages: [],
    playback: defaultPlaybackState()
  };
  rooms.set(roomId, newRoom);
  return newRoom;
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = createRoom(roomId);
  }
  return room;
}

function validVideoUrl(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function formatParticipants(room) {
  return Array.from(room.participants.values()).map((participant) => ({
    socketId: participant.socketId,
    name: participant.name,
    isHost: participant.socketId === room.hostSocketId,
    joinedAt: participant.joinedAt
  }));
}

function broadcastRoomState(room, socketToSkip) {
  const participants = formatParticipants(room);
  const broadcastTarget = socketToSkip ? io.to(room.id).except(socketToSkip.id) : io.to(room.id);
  broadcastTarget.emit('room:participants', {
    roomId: room.id,
    participants,
    hostSocketId: room.hostSocketId
  });

  const playbackPayload = {
    roomId: room.id,
    ...room.playback,
    participants,
    hostSocketId: room.hostSocketId
  };
  broadcastTarget.emit('room:sync', playbackPayload);
}

function cleanupRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  if (room.participants.size === 0) {
    rooms.delete(roomId);
  }
}

function chooseNewHost(room) {
  const allParticipants = Array.from(room.participants.values());
  if (allParticipants.length === 0) {
    room.hostSocketId = null;
    return;
  }

  const nextHost = allParticipants.sort((a, b) => a.joinedAt - b.joinedAt)[0];
  room.hostSocketId = nextHost.socketId;
}

function notifyRoomEvent(room, text, type = 'system') {
  const message = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sender: 'System',
    text,
    type,
    time: new Date().toISOString()
  };

  room.messages.push(message);
  if (room.messages.length > 100) {
    room.messages = room.messages.slice(-100);
  }

  io.to(room.id).emit('chat:message', message);
}

function registerSocketHandlers(socket) {
  socket.on('room:create', ({ name } = {}) => {
    const roomId = generateRoomId();
    const room = getRoom(roomId);
    room.hostSocketId = null;
    room.participants.clear();
    room.playback = defaultPlaybackState();
    room.messages = [];

    socket.join(roomId);
    const safeName = sanitizeName(name);
    room.participants.set(socket.id, {
      socketId: socket.id,
      name: safeName,
      joinedAt: Date.now()
    });
    room.hostSocketId = socket.id;

    const joinedState = {
      roomId,
      isHost: true,
      participants: formatParticipants(room),
      hostSocketId: room.hostSocketId,
      playback: room.playback,
      messages: room.messages
    };

    socket.emit('room:joined', joinedState);
    io.to(room.id).emit('room:participants', {
      roomId: room.id,
      participants: formatParticipants(room),
      hostSocketId: room.hostSocketId
    });
    notifyRoomEvent(room, `${safeName} created the room.`, 'system');
    socket.emit('room:video', room.playback);
  });

  socket.on('room:join', ({ roomId, name } = {}) => {
    const cleanedRoomId = sanitizeRoomId(roomId);
    if (!cleanedRoomId) {
      socket.emit('room:error', { message: 'Please provide a valid room code.' });
      return;
    }

    const room = getRoom(cleanedRoomId);
    const safeName = sanitizeName(name);

    if (room.participants.has(socket.id)) {
      room.participants.delete(socket.id);
    }

    socket.join(cleanedRoomId);
    room.participants.set(socket.id, {
      socketId: socket.id,
      name: safeName,
      joinedAt: Date.now()
    });

    if (!room.hostSocketId || !io.sockets.sockets.has(room.hostSocketId)) {
      room.hostSocketId = socket.id;
    }

    const isHost = socket.id === room.hostSocketId;
    const statePayload = {
      roomId: room.id,
      isHost,
      participants: formatParticipants(room),
      hostSocketId: room.hostSocketId,
      playback: room.playback,
      messages: room.messages
    };

    socket.emit('room:joined', statePayload);
    io.to(room.id).emit('room:participants', {
      roomId: room.id,
      participants: formatParticipants(room),
      hostSocketId: room.hostSocketId
    });

    if (room.playback.url) {
      socket.emit('room:video', room.playback);
    }

    socket.emit('room:sync', {
      roomId: room.id,
      ...room.playback,
      participants: formatParticipants(room),
      hostSocketId: room.hostSocketId
    });

    notifyRoomEvent(room, `${safeName} joined the room.`, 'system');
  });

  socket.on('chat:send', ({ roomId, text } = {}) => {
    const cleanedRoomId = sanitizeRoomId(roomId);
    if (!cleanedRoomId) {
      return;
    }

    const room = rooms.get(cleanedRoomId);
    if (!room) {
      return;
    }

    const participant = room.participants.get(socket.id);
    if (!participant) {
      return;
    }

    const safeText = String(text || '').trim();
    if (!safeText) {
      return;
    }

    const message = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sender: participant.name,
      text: safeText.slice(0, 500),
      type: 'message',
      time: new Date().toISOString()
    };

    room.messages.push(message);
    if (room.messages.length > 200) {
      room.messages = room.messages.slice(-200);
    }

    io.to(room.id).emit('chat:message', message);
  });

  socket.on('room:loadVideo', ({ roomId, url } = {}) => {
    const cleanedRoomId = sanitizeRoomId(roomId);
    if (!cleanedRoomId) {
      return;
    }

    const room = rooms.get(cleanedRoomId);
    if (!room || socket.id !== room.hostSocketId) {
      socket.emit('room:error', { message: 'Only the host can change the video.' });
      return;
    }

    if (!validVideoUrl(url)) {
      socket.emit('room:error', { message: 'Please enter a valid direct HTTP/HTTPS video URL.' });
      return;
    }

    room.playback = {
      url,
      currentTime: 0,
      duration: 0,
      isPlaying: false,
      state: 'loaded',
      lastUpdated: Date.now()
    };

    io.to(room.id).emit('room:video', room.playback);
    socket.to(room.id).emit('room:sync', {
      roomId: room.id,
      ...room.playback,
      participants: formatParticipants(room),
      hostSocketId: room.hostSocketId
    });
  });

  socket.on('room:state', (payload = {}) => {
    const room = rooms.get(payload.roomId);
    if (!room || socket.id !== room.hostSocketId) {
      return;
    }

    const nextPlayback = {
      ...room.playback,
      ...payload,
      url: payload.url || room.playback.url,
      currentTime: Number.isFinite(payload.currentTime) ? Number(payload.currentTime) : room.playback.currentTime,
      duration: Number.isFinite(payload.duration) ? Number(payload.duration) : room.playback.duration,
      isPlaying: Boolean(payload.isPlaying),
      lastUpdated: Date.now()
    };

    room.playback = nextPlayback;
    socket.to(room.id).emit('room:sync', {
      roomId: room.id,
      ...room.playback,
      participants: formatParticipants(room),
      hostSocketId: room.hostSocketId
    });
  });

  socket.on('room:removeParticipant', ({ roomId, targetSocketId } = {}) => {
    const cleanedRoomId = sanitizeRoomId(roomId);
    const room = rooms.get(cleanedRoomId);
    if (!room || socket.id !== room.hostSocketId) {
      return;
    }

    if (!targetSocketId || !room.participants.has(targetSocketId)) {
      return;
    }

    const participant = room.participants.get(targetSocketId);
    const targetSocket = io.sockets.sockets.get(targetSocketId);

    if (targetSocket) {
      targetSocket.leave(cleanedRoomId);
      targetSocket.emit('room:kicked', { roomId: cleanedRoomId, message: 'You were removed from the room by the host.' });
    }

    room.participants.delete(targetSocketId);
    if (room.hostSocketId === targetSocketId) {
      chooseNewHost(room);
    }

    io.to(cleanedRoomId).emit('room:participants', {
      roomId: cleanedRoomId,
      participants: formatParticipants(room),
      hostSocketId: room.hostSocketId
    });
    notifyRoomEvent(room, `${participant ? participant.name : 'A user'} left the room.`, 'system');
    cleanupRoomIfEmpty(cleanedRoomId);
  });

  socket.on('room:close', ({ roomId } = {}) => {
    const cleanedRoomId = sanitizeRoomId(roomId);
    const room = rooms.get(cleanedRoomId);
    if (!room || socket.id !== room.hostSocketId) {
      return;
    }

    io.to(cleanedRoomId).emit('room:closed', { roomId: cleanedRoomId, message: 'The host closed this room.' });
    const socketsInRoom = Array.from(io.sockets.adapter.rooms.get(cleanedRoomId) || []);
    socketsInRoom.forEach((socketId) => {
      const targetSocket = io.sockets.sockets.get(socketId);
      if (targetSocket) {
        targetSocket.leave(cleanedRoomId);
      }
    });

    rooms.delete(cleanedRoomId);
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (!room.participants.has(socket.id)) {
        continue;
      }

      const participant = room.participants.get(socket.id);
      room.participants.delete(socket.id);
      notifyRoomEvent(room, `${participant ? participant.name : 'A user'} left the room.`, 'system');

      if (room.hostSocketId === socket.id) {
        chooseNewHost(room);
      }

      io.to(room.id).emit('room:participants', {
        roomId: room.id,
        participants: formatParticipants(room),
        hostSocketId: room.hostSocketId
      });

      if (room.participants.size === 0) {
        rooms.delete(roomId);
      }
    }
  });
}

app.use(express.static(path.join(__dirname, '/')));

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'VERA is running' });
});

io.on('connection', registerSocketHandlers);

server.listen(PORT, HOST, () => {
  console.log(`VERA is running on http://${HOST}:${PORT}`);
});
