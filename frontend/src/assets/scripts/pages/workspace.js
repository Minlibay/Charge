import { apiFetch, buildWebsocketUrl } from '../api.js';
import { getApiBase, getToken, setToken, getLastRoom, setLastRoom } from '../storage.js';
import { setStatus, clearStatus, formatDate, autoResizeTextarea } from '../ui.js';

const state = {
  token: getToken(),
  currentRoom: null,
  currentChannel: null,
  chatSocket: null,
  voice: {
    ws: null,
    pc: null,
    localStream: null,
    remoteStream: new MediaStream(),
    joined: false,
    selectedDeviceId: null,
  },
};

const workspaceApiStatus = document.getElementById('workspace-api-status');
const workspaceAuthStatus = document.getElementById('workspace-auth-status');
const logoutButton = document.getElementById('logout-button');
const roomForm = document.getElementById('room-form');
const roomSlugInput = document.getElementById('room-slug');
const clearRoomBtn = document.getElementById('clear-room');
const roomSummary = document.getElementById('room-summary');
const channelManage = document.getElementById('channel-manage');
const channelCreateForm = document.getElementById('channel-create-form');
const channelNameInput = document.getElementById('channel-name');
const channelTypeSelect = document.getElementById('channel-type');
const channelCreateButton = document.getElementById('channel-create-submit');
const channelCreateStatus = document.getElementById('channel-create-status');
const channelsWrapper = document.getElementById('channels-wrapper');
const channelsList = document.getElementById('channels-list');
const channelSection = document.getElementById('channel-section');
const channelHeading = document.getElementById('channel-heading');
const channelHint = document.getElementById('channel-hint');
const channelTypePill = document.getElementById('channel-type-pill');
const textChat = document.getElementById('text-chat');
const chatStatus = document.getElementById('chat-status');
const chatHistory = document.getElementById('chat-history');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatDisconnect = document.getElementById('chat-disconnect');
const voiceChat = document.getElementById('voice-chat');
const voiceStatus = document.getElementById('voice-status');
const micSelect = document.getElementById('microphone-select');
const voiceConnect = document.getElementById('voice-connect');
const voiceDisconnect = document.getElementById('voice-disconnect');
const voiceStart = document.getElementById('voice-start');
const remoteAudio = document.getElementById('remote-audio');
const workspacePlaceholder = document.getElementById('workspace-placeholder');

function refreshConnectionIndicators() {
  setStatus(workspaceApiStatus, `API: ${getApiBase()}`, 'success');
  if (state.token) {
    setStatus(workspaceAuthStatus, 'Авторизация: активна', 'success');
  } else {
    setStatus(workspaceAuthStatus, 'Авторизация: отсутствует', 'error');
  }
}

function ensureAuthenticated() {
  if (!state.token) {
    setTimeout(() => {
      window.location.replace('./index.html#stay');
    }, 600);
    return false;
  }
  return true;
}

function toggleChannelManagement(visible) {
  if (channelManage) {
    channelManage.hidden = !visible;
  }
  [channelNameInput, channelTypeSelect, channelCreateButton].forEach((element) => {
    if (element) {
      element.disabled = !visible;
    }
  });
  if (!visible && channelCreateForm) {
    channelCreateForm.reset();
    clearStatus(channelCreateStatus);
  }
}

function resetWorkspaceView() {
  state.currentRoom = null;
  state.currentChannel = null;
  roomSummary.hidden = true;
  toggleChannelManagement(false);
  channelsWrapper.hidden = true;
  channelsList.innerHTML = '';
  channelSection.hidden = true;
  textChat.hidden = true;
  voiceChat.hidden = true;
  workspacePlaceholder.hidden = false;
  disconnectChat();
  disconnectVoice();
  updatePlaceholder();
}

function updateRoomSummary() {
  if (!state.currentRoom) {
    roomSummary.hidden = true;
    return;
  }
  const channelCount = Array.isArray(state.currentRoom.channels)
    ? state.currentRoom.channels.length
    : 0;
  setStatus(
    roomSummary,
    `${state.currentRoom.title} (${state.currentRoom.slug}) · ${channelCount} каналов`,
  );
}

function renderChannels(room) {
  channelsList.innerHTML = '';
  if (!room.channels || !room.channels.length) {
    const placeholder = document.createElement('div');
    placeholder.className = 'empty-placeholder';
    placeholder.textContent = 'В комнате пока нет каналов.';
    channelsList.appendChild(placeholder);
    return;
  }

  room.channels
    .slice()
    .sort((a, b) => a.letter.localeCompare(b.letter))
    .forEach((channel) => {
      const card = document.createElement('article');
      card.className = 'channel-card';
      card.dataset.channelLetter = channel.letter;
      card.dataset.channelId = channel.id;
      card.dataset.channelType = channel.type;

      const typeRow = document.createElement('div');
      typeRow.className = 'channel-type';
      typeRow.textContent = channel.type === 'text' ? 'Текстовый' : 'Голосовой';

      const title = document.createElement('div');
      title.className = 'channel-name';
      title.textContent = `${channel.letter} · ${channel.name}`;

      const description = document.createElement('div');
      description.className = 'channel-description';
      description.textContent = 'Откройте, чтобы просмотреть детали и подключиться.';

      card.append(typeRow, title, description);
      card.addEventListener('click', () => selectChannel(channel.letter));

      channelsList.appendChild(card);
    });
}

function updateChannelActiveState() {
  Array.from(channelsList.children).forEach((element) => {
    if (!(element instanceof HTMLElement)) return;
    const letter = element.dataset.channelLetter;
    element.classList.toggle('active', state.currentChannel?.letter === letter);
  });
}

function updatePlaceholder() {
  workspacePlaceholder.hidden = Boolean(state.currentChannel);
  if (!state.currentChannel) {
    workspacePlaceholder.textContent = state.currentRoom
      ? 'Выберите канал, чтобы открыть чат или голосовое подключение.'
      : 'Сначала загрузите комнату, чтобы работать с каналами.';
  }
}

function clearChannelSelection() {
  state.currentChannel = null;
  channelSection.hidden = true;
  textChat.hidden = true;
  voiceChat.hidden = true;
  channelHeading.textContent = 'Канал не выбран';
  channelHint.textContent = '';
  channelTypePill.textContent = '—';
  disconnectChat();
  disconnectVoice();
  updateChannelActiveState();
  updatePlaceholder();
}

function selectChannel(letter) {
  if (!state.currentRoom) return;
  const normalized = letter.toUpperCase();
  if (state.currentChannel?.letter === normalized) {
    clearChannelSelection();
    return;
  }
  const channel = state.currentRoom.channels.find((item) => item.letter === normalized);
  if (!channel) return;

  state.currentChannel = channel;
  channelSection.hidden = false;
  channelHeading.textContent = `${channel.name}`;
  channelHint.textContent = `Канал ${channel.letter} комнаты ${state.currentRoom.title}`;
  channelTypePill.textContent = channel.type === 'text' ? 'Text' : 'Voice';

  updateChannelActiveState();
  updatePlaceholder();

  if (channel.type === 'text') {
    voiceChat.hidden = true;
    setupTextChannel(channel);
  } else {
    textChat.hidden = true;
    setupVoiceChannel(channel);
  }
}

function disconnectChat() {
  if (state.chatSocket) {
    state.chatSocket.close();
    state.chatSocket = null;
  }
  chatHistory.innerHTML = '';
  chatInput.value = '';
  chatInput.disabled = true;
  chatSend.disabled = true;
  chatDisconnect.disabled = true;
  setStatus(chatStatus, 'Нет активного соединения');
}

function appendChatMessage(message) {
  const item = document.createElement('div');
  item.className = 'chat-item';
  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  const author = document.createElement('span');
  author.textContent = message.author_id ? `#${message.author_id}` : 'System';
  const time = document.createElement('span');
  time.textContent = formatDate(new Date(message.created_at ?? Date.now()));
  meta.append(author, time);
  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = message.content ?? '';
  item.append(meta, content);
  chatHistory.appendChild(item);
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function handleChatPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'history' && Array.isArray(payload.messages)) {
    chatHistory.innerHTML = '';
    payload.messages.forEach((message) => appendChatMessage(message));
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }
  if (payload.type === 'message' && payload.message) {
    appendChatMessage(payload.message);
  }
  if (payload.type === 'error' && payload.detail) {
    setStatus(chatStatus, payload.detail, 'error');
  }
}

function connectChat(channelId) {
  disconnectChat();
  if (!state.token) {
    setStatus(chatStatus, 'Необходимо войти', 'error');
    return;
  }
  setStatus(chatStatus, 'Подключение к WebSocket…');
  const wsUrl = new URL(buildWebsocketUrl(`/ws/text/${channelId}`));
  wsUrl.searchParams.set('token', state.token);
  const socket = new WebSocket(wsUrl.toString());
  state.chatSocket = socket;

  socket.addEventListener('open', () => {
    setStatus(chatStatus, 'Соединение установлено', 'success');
    chatInput.disabled = false;
    chatSend.disabled = false;
    chatDisconnect.disabled = false;
    chatInput.focus();
  });

  socket.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleChatPayload(payload);
    } catch (error) {
      console.error('Failed to parse chat payload', error);
    }
  });

  socket.addEventListener('close', () => {
    setStatus(chatStatus, 'Соединение закрыто');
    chatInput.disabled = true;
    chatSend.disabled = true;
    chatDisconnect.disabled = true;
  });

  socket.addEventListener('error', () => {
    setStatus(chatStatus, 'Ошибка WebSocket', 'error');
  });
}

function setupTextChannel(channel) {
  disconnectVoice();
  textChat.hidden = false;
  chatHistory.innerHTML = '';
  chatInput.value = '';
  chatInput.disabled = true;
  chatSend.disabled = true;
  chatDisconnect.disabled = true;
  setStatus(chatStatus, 'Подключение к WebSocket…');
  connectChat(channel.id);
}

function cleanupVoicePeerConnection() {
  if (state.voice.pc) {
    state.voice.pc.onicecandidate = null;
    state.voice.pc.ontrack = null;
    state.voice.pc.close();
    state.voice.pc = null;
  }
}

function disconnectVoice() {
  if (state.voice.ws) {
    sendVoiceBye(state.voice.ws);
    try {
      state.voice.ws.close();
    } catch (error) {
      console.error('Failed to close voice socket', error);
    }
  }
  state.voice.ws = null;
  cleanupVoicePeerConnection();
  if (state.voice.localStream) {
    state.voice.localStream.getTracks().forEach((track) => track.stop());
    state.voice.localStream = null;
  }
  state.voice.joined = false;
  state.voice.remoteStream = new MediaStream();
  remoteAudio.srcObject = null;
  setStatus(voiceStatus, 'Отключено');
  voiceDisconnect.disabled = true;
  voiceStart.disabled = true;
  voiceConnect.disabled = false;
}

function sendVoiceBye(socket = state.voice.ws) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'bye' }));
  }
}

async function ensureLocalStream() {
  const constraints = {
    audio: state.voice.selectedDeviceId
      ? { deviceId: { exact: state.voice.selectedDeviceId } }
      : true,
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.voice.localStream = stream;
  const pc = ensurePeerConnection();
  stream.getTracks().forEach((track) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === track.kind);
    if (sender) {
      sender.replaceTrack(track);
    } else {
      pc.addTrack(track, stream);
    }
  });
}

function ensurePeerConnection() {
  if (state.voice.pc) {
    return state.voice.pc;
  }
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  });
  pc.onicecandidate = (event) => {
    if (event.candidate && state.voice.ws) {
      state.voice.ws.send(
        JSON.stringify({
          type: 'candidate',
          candidate: event.candidate,
        }),
      );
    }
  };
  pc.ontrack = (event) => {
    state.voice.remoteStream.addTrack(event.track);
    remoteAudio.srcObject = state.voice.remoteStream;
  };
  state.voice.pc = pc;
  if (state.voice.localStream) {
    state.voice.localStream.getTracks().forEach((track) => pc.addTrack(track, state.voice.localStream));
  }
  return pc;
}

async function populateMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    micSelect.innerHTML = '<option value="">Микрофоны недоступны</option>';
    micSelect.disabled = true;
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((device) => device.kind === 'audioinput');
    micSelect.innerHTML = '';
    if (!audioInputs.length) {
      micSelect.innerHTML = '<option value="">Микрофоны не найдены</option>';
      micSelect.disabled = true;
      state.voice.selectedDeviceId = null;
      return;
    }
    micSelect.disabled = false;
    audioInputs.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Микрофон ${index + 1}`;
      if (state.voice.selectedDeviceId === device.deviceId) {
        option.selected = true;
      }
      micSelect.appendChild(option);
    });
    if (!state.voice.selectedDeviceId && audioInputs[0]) {
      state.voice.selectedDeviceId = audioInputs[0].deviceId;
      micSelect.value = audioInputs[0].deviceId;
    }
  } catch (error) {
    micSelect.innerHTML = '<option value="">Не удалось получить список устройств</option>';
    micSelect.disabled = true;
    console.error('Failed to enumerate devices', error);
  }
}

function setupVoiceChannel(channel) {
  disconnectChat();
  voiceChat.hidden = false;
  setStatus(voiceStatus, 'Готово к подключению');
  voiceConnect.disabled = false;
  voiceDisconnect.disabled = true;
  voiceStart.disabled = true;
  populateMicrophones();
}

function handleVoiceMessages(socket, message) {
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'error') {
    setStatus(voiceStatus, message.detail || 'Ошибка сигнального канала', 'error');
    return;
  }

  if (message.type === 'system') {
    if (message.event === 'welcome') {
      state.voice.joined = true;
      setStatus(voiceStatus, 'Подключено. Можно начинать звонок.', 'success');
      voiceStart.disabled = false;
    }
    if (message.event === 'peer-joined' && message.user) {
      setStatus(voiceStatus, `${message.user.displayName || message.user.id} подключился`, 'success');
    }
    if (message.event === 'peer-left' && message.user) {
      setStatus(voiceStatus, `${message.user.displayName || message.user.id} отключился`);
    }
    return;
  }

  if (!state.voice.joined) {
    // Ждём приветственное сообщение перед обработкой сигналов
    return;
  }

  const pc = ensurePeerConnection();

  switch (message.type) {
    case 'offer':
      (async () => {
        await pc.setRemoteDescription(new RTCSessionDescription(message.description));
        if (!state.voice.localStream) {
          await ensureLocalStream();
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.send(
          JSON.stringify({
            type: 'answer',
            description: pc.localDescription,
          }),
        );
      })().catch((error) => {
        console.error('Failed to handle offer', error);
      });
      break;
    case 'answer':
      (async () => {
        await pc.setRemoteDescription(new RTCSessionDescription(message.description));
      })().catch((error) => {
        console.error('Failed to apply answer', error);
      });
      break;
    case 'candidate':
      if (message.candidate) {
        (async () => {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
          } catch (error) {
            console.error('Failed to add ICE candidate', error);
          }
        })();
      }
      break;
    case 'bye':
      setStatus(voiceStatus, 'Удалённый участник завершил звонок');
      cleanupVoicePeerConnection();
      state.voice.remoteStream = new MediaStream();
      remoteAudio.srcObject = null;
      ensurePeerConnection();
      voiceStart.disabled = false;
      break;
    default:
      console.warn('Неизвестный сигнал', message);
  }
}

async function connectVoice() {
  if (!state.currentRoom || !state.currentChannel || state.currentChannel.type !== 'voice') {
    setStatus(voiceStatus, 'Выберите голосовой канал', 'error');
    return;
  }
  if (!state.token) {
    setStatus(voiceStatus, 'Необходимо войти', 'error');
    return;
  }
  if (!navigator.mediaDevices) {
    setStatus(voiceStatus, 'Браузер не поддерживает WebRTC', 'error');
    return;
  }
  const wsUrl = new URL(buildWebsocketUrl(`/ws/signal/${state.currentRoom.slug}`));
  wsUrl.searchParams.set('token', state.token);
  setStatus(voiceStatus, 'Подключение к голосовому серверу…');
  const socket = new WebSocket(wsUrl.toString());
  state.voice.ws = socket;
  state.voice.joined = false;

  socket.onopen = () => {
    setStatus(voiceStatus, 'Подключено. Запрашиваем устройства…');
    voiceConnect.disabled = true;
    voiceDisconnect.disabled = false;
    populateMicrophones()
      .then(() => ensureLocalStream())
      .then(() => {
        setStatus(voiceStatus, 'Локальный поток готов. Можно начинать звонок.');
        voiceStart.disabled = false;
      })
      .catch((error) => {
        setStatus(voiceStatus, error.message || 'Не удалось получить доступ к микрофону', 'error');
      });
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleVoiceMessages(socket, payload);
    } catch (error) {
      console.error('Failed to parse voice payload', error);
    }
  };

  socket.onclose = () => {
    setStatus(voiceStatus, 'Соединение закрыто');
    voiceConnect.disabled = false;
    voiceDisconnect.disabled = true;
    voiceStart.disabled = true;
    cleanupVoicePeerConnection();
    state.voice.joined = false;
    state.voice.ws = null;
  };

  socket.onerror = () => {
    setStatus(voiceStatus, 'Ошибка соединения', 'error');
  };
}

async function startVoiceCall() {
  if (!state.voice.ws || state.voice.ws.readyState !== WebSocket.OPEN) {
    setStatus(voiceStatus, 'Сначала подключитесь к голосовому серверу', 'error');
    return;
  }
  try {
    if (!state.voice.localStream) {
      await ensureLocalStream();
    }
    const pc = ensurePeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.voice.ws.send(
      JSON.stringify({
        type: 'offer',
        description: pc.localDescription,
      }),
    );
    setStatus(voiceStatus, 'Отправлен offer. Ожидаем ответ.', 'success');
  } catch (error) {
    setStatus(voiceStatus, error.message || 'Не удалось начать звонок', 'error');
  }
}

function handleChatSubmit(event) {
  event.preventDefault();
  if (!state.chatSocket || state.chatSocket.readyState !== WebSocket.OPEN) {
    setStatus(chatStatus, 'WebSocket не подключен', 'error');
    return;
  }
  const text = chatInput.value.trim();
  if (!text) {
    setStatus(chatStatus, 'Введите сообщение', 'error');
    return;
  }
  state.chatSocket.send(JSON.stringify({ content: text }));
  chatInput.value = '';
  autoResizeTextarea(chatInput);
}

async function loadRoom(slug) {
  if (!slug) return;
  clearChannelSelection();
  setStatus(roomSummary, 'Загрузка комнаты…');
  toggleChannelManagement(false);
  channelsWrapper.hidden = true;
  workspacePlaceholder.hidden = false;

  try {
    const room = await apiFetch(`/api/rooms/${encodeURIComponent(slug)}`);
    state.currentRoom = room;
    setLastRoom(room.slug);
    updateRoomSummary();
    toggleChannelManagement(true);
    channelsWrapper.hidden = false;
    renderChannels(room);
    updatePlaceholder();
    if (room.channels?.length) {
      selectChannel(room.channels[0].letter);
    }
  } catch (error) {
    resetWorkspaceView();
    setStatus(roomSummary, error.message, 'error');
  }
}

function initializeRoomForm() {
  const lastRoom = getLastRoom();
  if (lastRoom && roomSlugInput) {
    roomSlugInput.value = lastRoom;
    loadRoom(lastRoom);
  }
}

function setupEventListeners() {
  logoutButton?.addEventListener('click', () => {
    setToken(null);
    state.token = null;
    refreshConnectionIndicators();
    resetWorkspaceView();
    window.location.href = './index.html#stay';
  });

  roomForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const slug = roomSlugInput.value.trim();
    if (!slug) {
      setStatus(roomSummary, 'Введите slug комнаты', 'error');
      return;
    }
    loadRoom(slug);
  });

  clearRoomBtn?.addEventListener('click', () => {
    roomForm?.reset();
    setLastRoom(null);
    resetWorkspaceView();
    updatePlaceholder();
  });

  channelCreateForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.currentRoom) {
      setStatus(channelCreateStatus, 'Сначала загрузите комнату', 'error');
      return;
    }
    const name = channelNameInput.value.trim();
    const type = channelTypeSelect.value === 'voice' ? 'voice' : 'text';
    if (!name) {
      setStatus(channelCreateStatus, 'Введите название канала', 'error');
      channelNameInput.focus();
      return;
    }
    setStatus(channelCreateStatus, 'Создание канала…');
    channelCreateButton.disabled = true;
    try {
      const channel = await apiFetch(
        `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/channels`,
        {
          method: 'POST',
          body: JSON.stringify({ name, type }),
        },
      );
      const channels = Array.isArray(state.currentRoom.channels)
        ? state.currentRoom.channels.filter((item) => item.id !== channel.id)
        : [];
      channels.push(channel);
      state.currentRoom.channels = channels;
      renderChannels(state.currentRoom);
      updateRoomSummary();
      setStatus(channelCreateStatus, `Канал ${channel.letter} создан`, 'success');
      channelCreateForm.reset();
      channelNameInput.focus();
      selectChannel(channel.letter);
    } catch (error) {
      setStatus(channelCreateStatus, error.message, 'error');
    } finally {
      channelCreateButton.disabled = false;
    }
  });

  chatForm?.addEventListener('submit', handleChatSubmit);

  chatDisconnect?.addEventListener('click', () => {
    disconnectChat();
  });

  chatInput?.addEventListener('input', () => autoResizeTextarea(chatInput));

  voiceConnect?.addEventListener('click', () => {
    connectVoice();
  });

  voiceDisconnect?.addEventListener('click', () => {
    disconnectVoice();
  });

  voiceStart?.addEventListener('click', () => {
    startVoiceCall();
  });

  micSelect?.addEventListener('change', async () => {
    state.voice.selectedDeviceId = micSelect.value || null;
    if (state.voice.localStream) {
      state.voice.localStream.getTracks().forEach((track) => track.stop());
      state.voice.localStream = null;
    }
    if (state.voice.ws && state.voice.ws.readyState === WebSocket.OPEN) {
      try {
        await ensureLocalStream();
      } catch (error) {
        setStatus(voiceStatus, error.message, 'error');
      }
    }
  });
}

refreshConnectionIndicators();
if (!ensureAuthenticated()) {
  // Не запускаем остальную инициализацию, если пользователя перенаправляют
  return;
}

setupEventListeners();
initializeRoomForm();
updatePlaceholder();
