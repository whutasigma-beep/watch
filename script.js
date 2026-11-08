const state = {
  socket: null,
  roomId: '',
  isHost: false,
  currentVideoUrl: '',
  myName: '',
  participants: [],
  messages: [],
  hls: null,
  lastSyncAt: 0,
  lastHostSyncAt: 0,
  subtitleUrl: '',
  queueSync: false
};

const ui = {
  landing: document.getElementById('landingSection'),
  room: document.getElementById('roomSection'),
  displayName: document.getElementById('displayNameInput'),
  roomCode: document.getElementById('roomCodeInput'),
  createRoomBtn: document.getElementById('createRoomBtn'),
  joinRoomBtn: document.getElementById('joinRoomBtn'),
  roomIdLabel: document.getElementById('roomIdLabel'),
  participantCount: document.getElementById('participantCount'),
  participantsList: document.getElementById('participantsList'),
  copyInviteBtn: document.getElementById('copyInviteBtn'),
  videoUrlInput: document.getElementById('videoUrlInput'),
  subtitleUrlInput: document.getElementById('subtitleUrlInput'),
  loadVideoBtn: document.getElementById('loadVideoBtn'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  seekBackBtn: document.getElementById('seekBackBtn'),
  seekForwardBtn: document.getElementById('seekForwardBtn'),
  leaveRoomBtn: document.getElementById('leaveRoomBtn'),
  qualitySelect: document.getElementById('qualitySelect'),
  audioSelect: document.getElementById('audioSelect'),
  subtitleSelect: document.getElementById('subtitleSelect'),
  chatMessages: document.getElementById('chatMessages'),
  chatInput: document.getElementById('chatInput'),
  sendChatBtn: document.getElementById('sendChatBtn'),
  connectionBadge: document.getElementById('connectionBadge'),
  connectionText: document.getElementById('connectionText'),
  videoPlayer: document.getElementById('videoPlayer'),
  playerStatus: document.getElementById('playerStatus')
};

function setConnectionStatus(connected) {
  ui.connectionBadge.classList.toggle('connected', connected);
  ui.connectionBadge.classList.toggle('offline', !connected);
  ui.connectionText.textContent = connected ? 'Connected' : 'Connecting';
}

function showStatus(message, kind = 'info') {
  ui.playerStatus.textContent = message;
  ui.playerStatus.classList.remove('hidden');
  ui.playerStatus.dataset.kind = kind;
  window.clearTimeout(showStatus.timeoutId);
  showStatus.timeoutId = window.setTimeout(() => {
    ui.playerStatus.classList.add('hidden');
  }, 2200);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setRoomVisible(showRoom) {
  ui.landing.classList.toggle('hidden', showRoom);
  ui.room.classList.toggle('hidden', !showRoom);
}

function updateParticipantList() {
  const participants = state.participants || [];
  ui.participantCount.textContent = String(participants.length);

  ui.participantsList.innerHTML = participants.map((participant) => {
    const isHost = participant.isHost;
    const isRemovable = state.isHost && !isHost;
    return `
      <div class="participant-row">
        <div class="participant-main">
          <span class="avatar"></span>
          <span class="participant-name">${escapeHtml(participant.name)}</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="badge ${isHost ? 'host' : ''}">${isHost ? 'Host' : 'Guest'}</span>
          ${isRemovable ? `<button class="remove-btn" data-target-socket-id="${participant.socketId}">Remove</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function appendChatMessage(message) {
  const item = document.createElement('div');
  item.className = `chat-message ${message.type === 'system' ? 'system' : ''}`;
  item.innerHTML = `
    <div class="chat-meta">
      <span class="chat-sender">${escapeHtml(message.sender || 'System')}</span>
      <span>${new Date(message.time || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
    </div>
    <p class="chat-text">${escapeHtml(message.text || '')}</p>
  `;
  ui.chatMessages.appendChild(item);
  ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
}

function renderChatMessages() {
  ui.chatMessages.innerHTML = '';
  (state.messages || []).forEach((message) => appendChatMessage(message));
}

function roomShareLink() {
  const base = window.location.origin + window.location.pathname;
  return `${base}?room=${encodeURIComponent(state.roomId)}`;
}

function handleJoin() {
  const name = ui.displayName.value.trim() || 'Guest';
  state.myName = name;
  const roomId = ui.roomCode.value.trim();

  if (!state.socket) {
    state.socket = io();
  }

  if (!roomId) {
    state.socket.emit('room:create', { name });
    return;
  }

  state.socket.emit('room:join', { roomId, name });
}

function leaveRoom() {
  if (state.roomId && state.isHost) {
    state.socket.emit('room:close', { roomId: state.roomId });
  }

  resetRoomState();
}

function resetRoomState() {
  state.roomId = '';
  state.isHost = false;
  state.participants = [];
  state.messages = [];
  state.currentVideoUrl = '';
  stopHls();
  ui.videoPlayer.pause();
  ui.videoPlayer.removeAttribute('src');
  ui.videoPlayer.load();
  ui.roomIdLabel.textContent = '--';
  ui.videoUrlInput.value = '';
  ui.subtitleUrlInput.value = '';
  ui.chatMessages.innerHTML = '';
  ui.chatInput.value = '';
  ui.qualitySelect.innerHTML = '<option value="auto">Auto</option>';
  ui.audioSelect.innerHTML = '<option value="default">Default</option>';
  ui.subtitleSelect.innerHTML = '<option value="off">Off</option>';
  setRoomVisible(false);
  ui.roomCode.value = '';
}

function attachSocketEvents() {
  state.socket = io();

  state.socket.on('connect', () => {
    setConnectionStatus(true);
  });

  state.socket.on('disconnect', () => {
    setConnectionStatus(false);
  });

  state.socket.on('room:joined', (payload) => {
    state.roomId = payload.roomId;
    state.isHost = payload.isHost;
    state.participants = payload.participants || [];
    state.messages = payload.messages || [];
    ui.roomIdLabel.textContent = payload.roomId;
    setRoomVisible(true);
    updateParticipantList();
    renderChatMessages();

    const roomLink = roomShareLink();
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.set('room', payload.roomId);
    history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);

    if (payload.playback && payload.playback.url) {
      loadVideoIntoPlayer(payload.playback.url, false);
      if (Number.isFinite(payload.playback.currentTime)) {
        ui.videoPlayer.currentTime = Number(payload.playback.currentTime);
      }
      if (payload.playback.isPlaying) {
        ui.videoPlayer.play().catch(() => {});
      }
    }

    ui.playPauseBtn.textContent = state.isHost ? 'Pause' : 'Follow';
    ui.playPauseBtn.disabled = !state.isHost;
    ui.loadVideoBtn.disabled = !state.isHost;
    ui.videoUrlInput.disabled = !state.isHost;
    ui.subtitleUrlInput.disabled = !state.isHost;
  });

  state.socket.on('room:participants', (payload) => {
    state.participants = payload.participants || [];
    updateParticipantList();
  });

  state.socket.on('room:sync', (payload) => {
    if (!payload || !payload.roomId) {
      return;
    }

    if (state.isHost) {
      return;
    }

    if (payload.url && payload.url !== state.currentVideoUrl) {
      loadVideoIntoPlayer(payload.url, true);
    }

    if (Number.isFinite(payload.currentTime)) {
      const diff = Math.abs(ui.videoPlayer.currentTime - Number(payload.currentTime));
      if (diff > 1.2) {
        ui.videoPlayer.currentTime = Number(payload.currentTime);
      }
    }

    if (payload.duration && Number.isFinite(payload.duration)) {
      ui.videoPlayer.duration = Number(payload.duration);
    }

    if (payload.isPlaying && ui.videoPlayer.paused) {
      ui.videoPlayer.play().catch(() => {});
    }

    if (!payload.isPlaying && !ui.videoPlayer.paused) {
      ui.videoPlayer.pause();
    }
  });

  state.socket.on('room:video', (payload) => {
    if (!payload || !payload.url) {
      return;
    }

    state.currentVideoUrl = payload.url;
    loadVideoIntoPlayer(payload.url, state.isHost ? false : true);

    if (Number.isFinite(payload.currentTime)) {
      ui.videoPlayer.currentTime = Number(payload.currentTime);
    }

    if (payload.isPlaying) {
      ui.videoPlayer.play().catch(() => {});
    }
  });

  state.socket.on('chat:message', (message) => {
    state.messages.push(message);
    if (state.messages.length > 200) {
      state.messages = state.messages.slice(-200);
    }
    renderChatMessages();
  });

  state.socket.on('room:error', ({ message }) => {
    showStatus(message, 'error');
  });

  state.socket.on('room:kicked', ({ message }) => {
    showStatus(message, 'error');
    resetRoomState();
  });

  state.socket.on('room:closed', ({ message }) => {
    showStatus(message, 'error');
    resetRoomState();
  });

  ui.participantsList.addEventListener('click', (event) => {
    const button = event.target.closest('.remove-btn');
    if (!button || !state.isHost) {
      return;
    }

    const targetSocketId = button.getAttribute('data-target-socket-id');
    if (targetSocketId) {
      state.socket.emit('room:removeParticipant', {
        roomId: state.roomId,
        targetSocketId
      });
    }
  });

  state.socket.on('connect_error', () => {
    setConnectionStatus(false);
  });
}

function stopHls() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
}

function updateTrackSelectors(levels, audioTracks, subtitleTracks) {
  const levelOptions = ['<option value="auto">Auto</option>'];
  if (levels && levels.length) {
    levels.forEach((level, index) => {
      const label = level.name || `Quality ${index + 1}`;
      levelOptions.push(`<option value="${index}">${label}</option>`);
    });
  }
  ui.qualitySelect.innerHTML = levelOptions.join('');

  const audioOptions = ['<option value="default">Default</option>'];
  if (audioTracks && audioTracks.length) {
    audioTracks.forEach((track, index) => {
      const label = track.name || `Audio ${index + 1}`;
      audioOptions.push(`<option value="${index}">${label}</option>`);
    });
  }
  ui.audioSelect.innerHTML = audioOptions.join('');

  const subtitleOptions = ['<option value="off">Off</option>'];
  if (subtitleTracks && subtitleTracks.length) {
    subtitleTracks.forEach((track, index) => {
      const label = track.name || `Subtitle ${index + 1}`;
      subtitleOptions.push(`<option value="${index}">${label}</option>`);
    });
  }
  ui.subtitleSelect.innerHTML = subtitleOptions.join('');
}

function attachVideoEvents() {
  ui.videoPlayer.addEventListener('loadedmetadata', () => {
    if (state.isHost) {
      state.socket.emit('room:state', {
        roomId: state.roomId,
        url: state.currentVideoUrl,
        duration: Number.isFinite(ui.videoPlayer.duration) ? ui.videoPlayer.duration : 0,
        currentTime: ui.videoPlayer.currentTime,
        isPlaying: !ui.videoPlayer.paused
      });
    }
  });

  ui.videoPlayer.addEventListener('timeupdate', () => {
    if (state.isHost && Date.now() - state.lastHostSyncAt > 1100) {
      state.lastHostSyncAt = Date.now();
      state.socket.emit('room:state', {
        roomId: state.roomId,
        url: state.currentVideoUrl,
        duration: Number.isFinite(ui.videoPlayer.duration) ? ui.videoPlayer.duration : 0,
        currentTime: ui.videoPlayer.currentTime,
        isPlaying: !ui.videoPlayer.paused
      });
    }
  });

  ui.videoPlayer.addEventListener('play', () => {
    if (state.isHost) {
      state.socket.emit('room:state', {
        roomId: state.roomId,
        url: state.currentVideoUrl,
        duration: Number.isFinite(ui.videoPlayer.duration) ? ui.videoPlayer.duration : 0,
        currentTime: ui.videoPlayer.currentTime,
        isPlaying: true
      });
    }
    ui.playPauseBtn.textContent = 'Pause';
  });

  ui.videoPlayer.addEventListener('pause', () => {
    if (state.isHost) {
      state.socket.emit('room:state', {
        roomId: state.roomId,
        url: state.currentVideoUrl,
        duration: Number.isFinite(ui.videoPlayer.duration) ? ui.videoPlayer.duration : 0,
        currentTime: ui.videoPlayer.currentTime,
        isPlaying: false
      });
    }
    ui.playPauseBtn.textContent = 'Play';
  });

  ui.videoPlayer.addEventListener('seeked', () => {
    if (state.isHost) {
      state.socket.emit('room:state', {
        roomId: state.roomId,
        url: state.currentVideoUrl,
        duration: Number.isFinite(ui.videoPlayer.duration) ? ui.videoPlayer.duration : 0,
        currentTime: ui.videoPlayer.currentTime,
        isPlaying: !ui.videoPlayer.paused
      });
    }
  });
}

function loadVideoIntoPlayer(url, remoteSync) {
  if (!url) {
    return;
  }

  const normalized = url.trim();
  state.currentVideoUrl = normalized;
  ui.videoUrlInput.value = normalized;

  const lower = normalized.toLowerCase();
  if (lower.includes('.m3u8') || lower.includes('m3u8')) {
    loadHlsStream(normalized);
    return;
  }

  stopHls();
  ui.videoPlayer.src = normalized;
  ui.videoPlayer.load();

  if (normalized.toLowerCase().endsWith('.vtt') || normalized.toLowerCase().endsWith('.srt')) {
    showStatus('Subtitle track loaded.', 'info');
  }

  if (!remoteSync) {
    showStatus('Direct video source loaded.', 'info');
  }
}

function loadHlsStream(url) {
  stopHls();
  const hls = window.Hls ? new window.Hls({
    autoStartLoad: true,
    startLevel: -1,
    debug: false,
    capLevelToPlayerSize: true,
    partialSegments: true
  }) : null;

  if (!hls && ui.videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
    ui.videoPlayer.src = url;
    ui.videoPlayer.load();
    showStatus('Native HLS playback engaged.', 'info');
    return;
  }

  if (!hls) {
    showStatus('HLS.js is not available in this browser.', 'error');
    return;
  }

  state.hls = hls;
  hls.on(window.Hls.Events.MANIFEST_PARSED, (_, data) => {
    updateTrackSelectors(data.levels || [], hls.audioTracks || [], hls.subtitleTracks || []);
    showStatus('HLS stream loaded successfully.', 'info');
  });

  hls.on(window.Hls.Events.ERROR, (_, data) => {
    const errorMessage = data && data.reason ? data.reason : 'Unable to load HLS stream.';
    showStatus(`HLS error: ${errorMessage}`, 'error');
  });

  hls.on(window.Hls.Events.LEVEL_SWITCHED, (_, data) => {
    const level = hls.levels[data.level];
    if (level) {
      ui.qualitySelect.value = String(data.level);
    }
  });

  hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => {
    updateTrackSelectors(hls.levels || [], hls.audioTracks || [], hls.subtitleTracks || []);
  });

  hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
    updateTrackSelectors(hls.levels || [], hls.audioTracks || [], hls.subtitleTracks || []);
  });

  hls.attachMedia(ui.videoPlayer);
  hls.loadSource(url);
}

function emitHostSync(action) {
  if (!state.isHost || !state.roomId) {
    return;
  }

  state.socket.emit('room:state', {
    roomId: state.roomId,
    url: state.currentVideoUrl,
    duration: Number.isFinite(ui.videoPlayer.duration) ? ui.videoPlayer.duration : 0,
    currentTime: ui.videoPlayer.currentTime,
    isPlaying: action === 'play' ? true : action === 'pause' ? false : !ui.videoPlayer.paused,
    action
  });
}

function bindControls() {
  ui.createRoomBtn.addEventListener('click', () => {
    handleJoin();
  });

  ui.joinRoomBtn.addEventListener('click', () => {
    handleJoin();
  });

  ui.loadVideoBtn.addEventListener('click', () => {
    if (!state.isHost || !state.roomId) {
      return;
    }

    const url = ui.videoUrlInput.value.trim();
    if (!url) {
      showStatus('Enter a direct video URL first.', 'error');
      return;
    }

    if (ui.subtitleUrlInput.value.trim()) {
      state.subtitleUrl = ui.subtitleUrlInput.value.trim();
      addSubtitleTrack(state.subtitleUrl);
    }

    state.socket.emit('room:loadVideo', { roomId: state.roomId, url });
  });

  ui.copyInviteBtn.addEventListener('click', async () => {
    if (!state.roomId) {
      return;
    }

    try {
      await navigator.clipboard.writeText(roomShareLink());
      showStatus('Invite link copied.', 'info');
    } catch (error) {
      showStatus('Copy failed. Copy the room URL manually.', 'error');
    }
  });

  ui.playPauseBtn.addEventListener('click', () => {
    if (!state.isHost || !state.roomId) {
      return;
    }

    if (ui.videoPlayer.paused) {
      ui.videoPlayer.play().catch(() => {});
      emitHostSync('play');
    } else {
      ui.videoPlayer.pause();
      emitHostSync('pause');
    }
  });

  ui.seekBackBtn.addEventListener('click', () => {
    if (!state.isHost || !state.roomId) {
      return;
    }
    ui.videoPlayer.currentTime = Math.max(0, ui.videoPlayer.currentTime - 10);
    emitHostSync('seek');
  });

  ui.seekForwardBtn.addEventListener('click', () => {
    if (!state.isHost || !state.roomId) {
      return;
    }
    ui.videoPlayer.currentTime = Math.min(ui.videoPlayer.duration || ui.videoPlayer.currentTime, ui.videoPlayer.currentTime + 10);
    emitHostSync('seek');
  });

  ui.leaveRoomBtn.addEventListener('click', leaveRoom);

  ui.qualitySelect.addEventListener('change', () => {
    if (!state.hls || !state.isHost) {
      return;
    }
    const index = Number(ui.qualitySelect.value);
    if (!Number.isNaN(index) && index >= 0) {
      state.hls.currentLevel = index;
    }
  });

  ui.audioSelect.addEventListener('change', () => {
    if (!state.hls || !state.isHost) {
      return;
    }
    const index = Number(ui.audioSelect.value);
    if (!Number.isNaN(index) && index >= 0 && state.hls.audioTracks && state.hls.audioTracks[index]) {
      state.hls.audioTrack = index;
    }
  });

  ui.subtitleSelect.addEventListener('change', () => {
    if (!state.hls || !state.isHost) {
      return;
    }
    const index = Number(ui.subtitleSelect.value);
    if (!Number.isNaN(index) && index >= 0 && state.hls.subtitleTracks && state.hls.subtitleTracks[index]) {
      state.hls.subtitleTrack = index;
    }
  });

  ui.sendChatBtn.addEventListener('click', () => {
    const text = ui.chatInput.value.trim();
    if (!text || !state.roomId) {
      return;
    }
    state.socket.emit('chat:send', { roomId: state.roomId, text });
    ui.chatInput.value = '';
  });

  ui.chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      ui.sendChatBtn.click();
    }
  });
}

function addSubtitleTrack(url) {
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = 'External Subtitle';
  track.srclang = 'en';
  track.src = url;
  track.default = true;

  const existingTracks = Array.from(ui.videoPlayer.querySelectorAll('track'));
  for (const existingTrack of existingTracks) {
    existingTrack.remove();
  }

  ui.videoPlayer.appendChild(track);
  ui.videoPlayer.textTracks[0].mode = 'showing';
}

function bootstrap() {
  attachSocketEvents();
  bindControls();
  attachVideoEvents();

  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  const savedName = localStorage.getItem('vera-name');
  if (savedName) {
    ui.displayName.value = savedName;
  }

  ui.displayName.addEventListener('change', () => {
    localStorage.setItem('vera-name', ui.displayName.value.trim());
  });

  if (roomParam) {
    ui.roomCode.value = roomParam;
  }

  if (savedName && roomParam) {
    handleJoin();
  }
}

bootstrap();
