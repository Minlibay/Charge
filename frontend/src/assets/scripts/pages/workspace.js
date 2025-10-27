import { apiFetch, buildWebsocketUrl, resolveApiUrl } from '../api.js';
import { getApiBase, getToken, setToken, getLastRoom, setLastRoom } from '../storage.js';
import { setStatus, clearStatus, formatDate, autoResizeTextarea } from '../ui.js';

const DEFAULT_VOICE_STATS = Object.freeze({
  total: 0,
  speakers: 0,
  listeners: 0,
  activeSpeakers: 0,
  createdAt: null,
  updatedAt: null,
});

const state = {
  token: getToken(),
  currentUserId: null,
  currentRoom: null,
  currentChannel: null,
  chatSocket: null,
  categories: [],
  invitations: [],
  roleHierarchy: [],
  currentRole: null,
  config: {
    webrtc: {
      iceServers: [],
      stun: [],
      turn: { urls: [], username: null, credential: null },
      defaults: {},
      recording: { enabled: false, serviceUrl: null },
      monitoring: { enabled: false, endpoint: null, pollInterval: 15 },
    },
  },
  chat: {
    messages: [],
    attachments: [],
    replyParentId: null,
    replyMessage: null,
    threadRootId: null,
    threadMessages: [],
    searchVisible: false,
    searchResults: [],
    onlineUsers: [],
    typingUsers: new Map(),
    typingCleanupTimer: null,
    selfTypingActive: false,
    selfTypingTimeout: null,
  },
  voice: {
    ws: null,
    pc: null,
    localStream: null,
    remoteStream: new MediaStream(),
    joined: false,
    selectedDeviceId: null,
    selectedCameraId: null,
    enableVideo: false,
    participants: new Map(),
    qualityReports: new Map(),
    mediaStreams: new Map(),
    videoElements: new Map(),
    lastSignalSenderId: null,
    features: {
      recording: false,
      qualityMonitoring: false,
    },
    recordingActive: false,
    self: {
      id: null,
      role: 'listener',
      muted: false,
      deafened: false,
      videoEnabled: false,
    },
    qualityTimer: null,
    stats: { ...DEFAULT_VOICE_STATS },
  },
};

function decodeUserIdFromToken(token) {
  if (!token) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  try {
    const payload = JSON.parse(atob(parts[1]));
    const identifier = payload.sub ?? payload.user_id ?? payload.id;
    const numericId = Number(identifier);
    return Number.isFinite(numericId) ? numericId : null;
  } catch (error) {
    console.warn('Failed to decode user id from token', error);
    return null;
  }
}

state.currentUserId = decodeUserIdFromToken(state.token);
state.voice.self.id = state.currentUserId;

const QUICK_REACTIONS = ['👍', '❤️', '🎉', '👀', '🔥'];

const VOICE_ROLE_LABELS = {
  speaker: 'Спикер',
  listener: 'Слушатель',
};

function normalizeVoiceStats(raw, fallback = DEFAULT_VOICE_STATS) {
  const base = {
    total: fallback?.total ?? 0,
    speakers: fallback?.speakers ?? 0,
    listeners: fallback?.listeners ?? 0,
    activeSpeakers: fallback?.activeSpeakers ?? 0,
    createdAt: fallback?.createdAt ?? null,
    updatedAt: fallback?.updatedAt ?? null,
  };
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  const toCount = (value, previous) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : previous;
  };
  if (raw.total !== undefined) {
    base.total = toCount(raw.total, base.total);
  }
  if (raw.speakers !== undefined) {
    base.speakers = toCount(raw.speakers, base.speakers);
  }
  if (raw.listeners !== undefined) {
    base.listeners = toCount(raw.listeners, base.listeners);
  }
  if (raw.activeSpeakers !== undefined) {
    base.activeSpeakers = toCount(raw.activeSpeakers, base.activeSpeakers);
  }
  if (raw.createdAt !== undefined) {
    base.createdAt = raw.createdAt;
  }
  if (raw.updatedAt !== undefined) {
    base.updatedAt = raw.updatedAt;
  }
  return base;
}

function mergeVoiceStats(raw) {
  const merged = normalizeVoiceStats(
    raw ? { ...state.voice.stats, ...raw } : state.voice.stats,
    state.voice.stats,
  );
  state.voice.stats = merged;
  updateVoiceStatsUI();
  return merged;
}

async function loadRuntimeConfig() {
  try {
    const config = await apiFetch('/api/config/webrtc');
    if (!config || typeof config !== 'object') {
      return;
    }
    const stunServers = Array.isArray(config.stun)
      ? config.stun.map((item) => String(item))
      : typeof config.stun === 'string'
      ? config.stun.split(',').map((item) => item.trim()).filter(Boolean)
      : [];
    const turnUrls = Array.isArray(config.turn?.urls)
      ? config.turn.urls.map((item) => String(item))
      : config.turn?.urls
      ? [String(config.turn.urls)]
      : [];
    state.config.webrtc = {
      iceServers: Array.isArray(config.iceServers) ? config.iceServers : [],
      stun: stunServers,
      turn: {
        urls: turnUrls,
        username: config.turn?.username ?? null,
        credential: config.turn?.credential ?? null,
      },
      defaults: config.defaults ?? {},
      recording: {
        enabled: Boolean(config.recording?.enabled),
        serviceUrl: config.recording?.serviceUrl ?? null,
      },
      monitoring: {
        enabled: Boolean(config.monitoring?.enabled),
        endpoint: config.monitoring?.endpoint ?? null,
        pollInterval: Number.parseInt(config.monitoring?.pollInterval, 10) || 15,
      },
    };
    state.voice.features.recording = state.config.webrtc.recording.enabled;
    state.voice.features.qualityMonitoring = state.config.webrtc.monitoring.enabled;
  } catch (error) {
    console.warn('Не удалось загрузить конфигурацию WebRTC', error);
  }
}

function getIceServers() {
  const servers = [];
  const configured = state.config.webrtc?.iceServers;
  if (Array.isArray(configured)) {
    configured.forEach((server) => {
      if (typeof server === 'string') {
        servers.push({ urls: server });
      } else if (Array.isArray(server?.urls)) {
        servers.push(server);
      } else if (server && typeof server === 'object') {
        servers.push({
          urls: server.urls ?? [],
          username: server.username ?? undefined,
          credential: server.credential ?? undefined,
        });
      }
    });
  }

  const stunServers = Array.isArray(state.config.webrtc?.stun)
    ? state.config.webrtc.stun
    : [];
  stunServers.forEach((entry) => {
    if (Array.isArray(entry)) {
      servers.push({ urls: entry });
    } else if (entry) {
      servers.push({ urls: String(entry) });
    }
  });

  const turnConfig = state.config.webrtc?.turn;
  if (turnConfig && Array.isArray(turnConfig.urls) && turnConfig.urls.length) {
    servers.push({
      urls: turnConfig.urls,
      username: turnConfig.username ?? undefined,
      credential: turnConfig.credential ?? undefined,
    });
  }

  if (!servers.length) {
    servers.push({ urls: 'stun:stun.l.google.com:19302' });
  }
  return servers;
}

const workspaceApiStatus = document.getElementById('workspace-api-status');
const workspaceAuthStatus = document.getElementById('workspace-auth-status');
const logoutButton = document.getElementById('logout-button');
const roomForm = document.getElementById('room-form');
const roomSlugInput = document.getElementById('room-slug');
const clearRoomBtn = document.getElementById('clear-room');
const roomSummary = document.getElementById('room-summary');
const roomCreateSection = document.getElementById('room-create');
const roomCreateForm = document.getElementById('room-create-form');
const roomTitleInput = document.getElementById('room-title');
const roomCreateSubmit = document.getElementById('room-create-submit');
const roomCreateStatus = document.getElementById('room-create-status');
const channelManage = document.getElementById('channel-manage');
const channelCreateForm = document.getElementById('channel-create-form');
const channelNameInput = document.getElementById('channel-name');
const channelCategorySelect = document.getElementById('channel-category-select');
const channelCreateButtons = channelCreateForm
  ? Array.from(channelCreateForm.querySelectorAll('button[data-channel-type]'))
  : [];
const channelCreateStatus = document.getElementById('channel-create-status');
const categoryManage = document.getElementById('category-manage');
const categoryCreateForm = document.getElementById('category-create-form');
const categoryNameInput = document.getElementById('category-name');
const categoryPositionInput = document.getElementById('category-position');
const categoryManageStatus = document.getElementById('category-manage-status');
const categoryList = document.getElementById('category-list');
const invitationManage = document.getElementById('invitation-manage');
const invitationCreateForm = document.getElementById('invitation-create-form');
const invitationRoleSelect = document.getElementById('invitation-role');
const invitationExpiresInput = document.getElementById('invitation-expires');
const invitationStatus = document.getElementById('invitation-status');
const invitationList = document.getElementById('invitation-list');
const roleManage = document.getElementById('role-manage');
const memberRoleForm = document.getElementById('member-role-form');
const memberRoleUserInput = document.getElementById('member-role-user');
const memberRoleSelect = document.getElementById('member-role-select');
const memberRoleStatus = document.getElementById('member-role-status');
const roleHierarchyList = document.getElementById('role-hierarchy-list');
const roleLevelForm = document.getElementById('role-level-form');
const roleLevelSelect = document.getElementById('role-level-select');
const roleLevelInput = document.getElementById('role-level-value');
const roleLevelStatus = document.getElementById('role-level-status');
const channelsWrapper = document.getElementById('channels-wrapper');
const channelsList = document.getElementById('channels-list');
const channelSection = document.getElementById('channel-section');
const channelHeading = document.getElementById('channel-heading');
const channelHint = document.getElementById('channel-hint');
const channelTypePill = document.getElementById('channel-type-pill');
const channelAdmin = document.getElementById('channel-admin');
const channelCategoryAssign = document.getElementById('channel-category-assign');
const channelCategorySave = document.getElementById('channel-category-save');
const channelCategoryStatus = document.getElementById('channel-category-status');
const textChat = document.getElementById('text-chat');
const chatStatus = document.getElementById('chat-status');
const chatPresence = document.getElementById('chat-presence');
const chatPresenceText = document.getElementById('chat-presence-text');
const chatTyping = document.getElementById('chat-typing');
const chatTypingText = document.getElementById('chat-typing-text');
const chatHistory = document.getElementById('chat-history');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatDisconnect = document.getElementById('chat-disconnect');
const chatAttachmentInput = document.getElementById('chat-attachment-input');
const chatAttachmentList = document.getElementById('chat-attachment-list');
const chatReplyPreview = document.getElementById('chat-reply-preview');
const chatReplyTarget = document.getElementById('chat-reply-target');
const chatReplyPreviewText = document.getElementById('chat-reply-preview-text');
const chatReplyClear = document.getElementById('chat-reply-clear');
const chatThreadPanel = document.getElementById('chat-thread');
const chatThreadTitle = document.getElementById('chat-thread-title');
const chatThreadList = document.getElementById('chat-thread-messages');
const chatThreadClose = document.getElementById('chat-thread-close');
const chatSearchToggle = document.getElementById('chat-search-toggle');
const chatSearchPanel = document.getElementById('chat-search-panel');
const chatSearchForm = document.getElementById('chat-search-form');
const chatSearchQueryInput = document.getElementById('chat-search-query');
const chatSearchAuthorInput = document.getElementById('chat-search-author');
const chatSearchAttachmentSelect = document.getElementById('chat-search-has-attachments');
const chatSearchStartInput = document.getElementById('chat-search-start');
const chatSearchEndInput = document.getElementById('chat-search-end');
const chatSearchResults = document.getElementById('chat-search-results');
const chatSearchClose = document.getElementById('chat-search-close');
const voiceChat = document.getElementById('voice-chat');
const voiceStatus = document.getElementById('voice-status');
const micSelect = document.getElementById('microphone-select');
const cameraSelect = document.getElementById('camera-select');
const voiceConnect = document.getElementById('voice-connect');
const voiceDisconnect = document.getElementById('voice-disconnect');
const voiceStart = document.getElementById('voice-start');
const voiceRoleToggle = document.getElementById('voice-role-toggle');
const voiceMuteToggle = document.getElementById('voice-mute-toggle');
const voiceDeafenToggle = document.getElementById('voice-deafen-toggle');
const voiceVideoToggle = document.getElementById('voice-video-toggle');
const voiceRecordingToggle = document.getElementById('voice-recording-toggle');
const voiceParticipantsGrid = document.getElementById('voice-participants-grid');
const voiceVideoWall = document.getElementById('voice-video-wall');
const voiceStatsPanel = document.getElementById('voice-stats');
const voiceTotalCount = document.getElementById('voice-total-count');
const voiceSpeakerCount = document.getElementById('voice-speaker-count');
const voiceListenerCount = document.getElementById('voice-listener-count');
const voiceActiveCount = document.getElementById('voice-active-count');
const voiceQualityPanel = document.getElementById('voice-quality-panel');
const voiceQualityList = document.getElementById('voice-quality-list');
const remoteAudio = document.getElementById('remote-audio');
const workspacePlaceholder = document.getElementById('workspace-placeholder');

updateVoiceStatsUI();

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
  const interactiveElements = [channelNameInput, channelCategorySelect, ...channelCreateButtons];
  interactiveElements.forEach((element) => {
    if (element) {
      element.disabled = !visible;
    }
  });
  if (!visible && channelCreateForm) {
    channelCreateForm.reset();
    clearStatus(channelCreateStatus);
  }
  if (visible) {
    updateCategorySelectOptions();
  }
}

function toggleCategoryManagement(visible) {
  if (categoryManage) {
    categoryManage.hidden = !visible;
  }
  const interactive = [
    categoryNameInput,
    categoryPositionInput,
    ...(categoryCreateForm ? Array.from(categoryCreateForm.querySelectorAll('button[type="submit"]')) : []),
  ];
  interactive.forEach((element) => {
    if (element) {
      element.disabled = !visible;
    }
  });
  if (!visible) {
    categoryList.innerHTML = '';
    clearStatus(categoryManageStatus);
    categoryCreateForm?.reset();
  } else {
    renderCategories();
  }
}

function toggleInvitationManagement(visible) {
  if (invitationManage) {
    invitationManage.hidden = !visible;
  }
  const controls = [
    invitationRoleSelect,
    invitationExpiresInput,
    ...(invitationCreateForm ? Array.from(invitationCreateForm.querySelectorAll('button[type="submit"]')) : []),
  ];
  controls.forEach((element) => {
    if (element) {
      element.disabled = !visible;
    }
  });
  if (!visible) {
    invitationList.innerHTML = '';
    clearStatus(invitationStatus);
    invitationCreateForm?.reset();
  } else {
    renderInvitations();
  }
}

function toggleRoleManagement(visible) {
  if (roleManage) {
    roleManage.hidden = !visible;
  }
  const controls = [
    memberRoleUserInput,
    memberRoleSelect,
    ...(memberRoleForm ? Array.from(memberRoleForm.querySelectorAll('button[type="submit"]')) : []),
  ];
  controls.forEach((element) => {
    if (element) {
      element.disabled = !visible;
    }
  });
  if (!visible) {
    roleHierarchyList.innerHTML = '';
    clearStatus(memberRoleStatus);
    memberRoleForm?.reset();
  } else {
    updateRoleSelectors();
    renderRoleHierarchy();
  }
}

function toggleOwnerRoleControls(visible) {
  if (!roleLevelForm) return;
  roleLevelForm.hidden = !visible;
  const controls = [
    roleLevelSelect,
    roleLevelInput,
    ...Array.from(roleLevelForm.querySelectorAll('button[type="submit"]')),
  ];
  controls.forEach((element) => {
    if (element) {
      element.disabled = !visible;
    }
  });
  if (!visible) {
    clearStatus(roleLevelStatus);
    roleLevelForm.reset();
  } else {
    updateRoleSelectors();
  }
}

function isAdminRole(role) {
  return role === 'owner' || role === 'admin';
}

function isOwnerRole(role) {
  return role === 'owner';
}

function updateManagementSections() {
  const role = state.currentRole;
  const isAdmin = isAdminRole(role);
  toggleChannelManagement(isAdmin);
  toggleCategoryManagement(isAdmin);
  toggleInvitationManagement(isAdmin);
  toggleRoleManagement(isAdmin);
  toggleOwnerRoleControls(isOwnerRole(role));
  updateChannelAdminTools();
}

function updateCategorySelectOptions() {
  const categories = Array.isArray(state.categories)
    ? state.categories.slice().sort((a, b) => {
        if (a.position === b.position) {
          return a.name.localeCompare(b.name);
        }
        return a.position - b.position;
      })
    : [];
  const selects = [channelCategorySelect, channelCategoryAssign];
  selects.forEach((select) => {
    if (!select) return;
    const previous = select.value;
    select.innerHTML = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Без категории';
    select.appendChild(defaultOption);
    categories.forEach((category) => {
      const option = document.createElement('option');
      option.value = String(category.id);
      option.textContent = category.name;
      select.appendChild(option);
    });
    if (previous && categories.some((category) => String(category.id) === previous)) {
      select.value = previous;
    } else {
      select.value = '';
    }
  });
}

function formatRole(role) {
  switch (role) {
    case 'owner':
      return 'Владелец';
    case 'admin':
      return 'Администратор';
    case 'member':
      return 'Участник';
    case 'guest':
      return 'Гость';
    default:
      return role;
  }
}

function formatChannelType(type) {
  switch (type) {
    case 'voice':
      return 'Голосовой';
    case 'announcement':
      return 'Анонсовый';
    case 'text':
    default:
      return 'Текстовый';
  }
}

function renderCategories() {
  if (!categoryList) return;
  categoryList.innerHTML = '';
  const categories = Array.isArray(state.categories)
    ? state.categories.slice().sort((a, b) => {
        if (a.position === b.position) {
          return a.name.localeCompare(b.name);
        }
        return a.position - b.position;
      })
    : [];
  if (!categories.length) {
    const empty = document.createElement('li');
    empty.className = 'category-empty';
    empty.textContent = 'Категории пока не созданы.';
    categoryList.appendChild(empty);
    return;
  }

  const channelCounts = new Map();
  if (Array.isArray(state.currentRoom?.channels)) {
    state.currentRoom.channels.forEach((channel) => {
      const key = channel.category_id ?? null;
      channelCounts.set(key, (channelCounts.get(key) || 0) + 1);
    });
  }

  categories.forEach((category) => {
    const item = document.createElement('li');
    item.className = 'category-item';
    item.dataset.categoryId = String(category.id);

    const info = document.createElement('div');
    info.className = 'category-info';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'category-name';
    nameSpan.textContent = category.name;
    const metaSpan = document.createElement('span');
    metaSpan.className = 'category-meta';
    const count = channelCounts.get(category.id) || 0;
    metaSpan.textContent = `Позиция ${category.position} · ${count} канал(ов)`;
    info.append(nameSpan, metaSpan);

    const actions = document.createElement('div');
    actions.className = 'category-actions';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'ghost';
    editButton.textContent = 'Редактировать';
    editButton.addEventListener('click', () => editCategory(category.id));
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'ghost danger-action';
    deleteButton.textContent = 'Удалить';
    deleteButton.addEventListener('click', () => deleteCategory(category.id));
    actions.append(editButton, deleteButton);

    item.append(info, actions);
    categoryList.appendChild(item);
  });
}

async function editCategory(categoryId) {
  if (!state.currentRoom) return;
  const category = state.categories.find((item) => item.id === categoryId);
  if (!category) return;

  const newNameRaw = prompt('Новое название категории', category.name);
  if (newNameRaw === null) {
    return;
  }
  const newName = newNameRaw.trim();
  if (!newName) {
    setStatus(categoryManageStatus, 'Название не может быть пустым', 'error');
    return;
  }

  const positionRaw = prompt('Новая позиция категории', String(category.position));
  let newPosition = category.position;
  if (positionRaw !== null && positionRaw.trim() !== '') {
    const parsed = Number(positionRaw);
    if (Number.isNaN(parsed)) {
      setStatus(categoryManageStatus, 'Позиция должна быть числом', 'error');
      return;
    }
    newPosition = parsed;
  }

  const payload = {};
  if (newName !== category.name) {
    payload.name = newName;
  }
  if (newPosition !== category.position) {
    payload.position = newPosition;
  }
  if (!Object.keys(payload).length) {
    return;
  }

  try {
    await apiFetch(
      `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/categories/${categoryId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
    );
    setStatus(categoryManageStatus, 'Категория обновлена', 'success');
    await refreshCategories();
  } catch (error) {
    setStatus(categoryManageStatus, error.message, 'error');
  }
}

async function deleteCategory(categoryId) {
  if (!state.currentRoom) return;
  try {
    await apiFetch(
      `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/categories/${categoryId}`,
      { method: 'DELETE' },
    );
    setStatus(categoryManageStatus, 'Категория удалена', 'success');
    await refreshCategories();
  } catch (error) {
    setStatus(categoryManageStatus, error.message, 'error');
  }
}

async function refreshCategories() {
  if (!state.currentRoom) return;
  try {
    const categories = await apiFetch(
      `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/categories`,
    );
    state.categories = Array.isArray(categories) ? categories : [];
    renderCategories();
    updateCategorySelectOptions();
    updateChannelAdminTools();
    if (state.currentRoom) {
      renderChannels(state.currentRoom);
    }
  } catch (error) {
    setStatus(categoryManageStatus, error.message, 'error');
  }
}

function renderInvitations() {
  if (!invitationList) return;
  invitationList.innerHTML = '';
  const invitations = Array.isArray(state.invitations)
    ? state.invitations.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    : [];
  if (!invitations.length) {
    const empty = document.createElement('li');
    empty.className = 'invitation-empty';
    empty.textContent = 'Приглашения ещё не созданы.';
    invitationList.appendChild(empty);
    return;
  }

  invitations.forEach((invitation) => {
    const item = document.createElement('li');
    item.className = 'invitation-item';
    item.dataset.invitationId = String(invitation.id);

    const info = document.createElement('div');
    info.className = 'invitation-info';
    const code = document.createElement('code');
    code.textContent = invitation.code;
    const details = document.createElement('span');
    const expiry = invitation.expires_at
      ? formatDate(new Date(invitation.expires_at))
      : 'без срока';
    details.textContent = `${formatRole(invitation.role)} · действует до ${expiry}`;
    info.append(code, details);

    const actions = document.createElement('div');
    actions.className = 'invitation-actions';
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'ghost danger-action';
    deleteButton.textContent = 'Отозвать';
    deleteButton.addEventListener('click', () => deleteInvitation(invitation.id));
    actions.append(deleteButton);

    item.append(info, actions);
    invitationList.appendChild(item);
  });
}

async function refreshInvitations() {
  if (!state.currentRoom || !isAdminRole(state.currentRole)) return;
  try {
    const invitations = await apiFetch(
      `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/invitations`,
    );
    state.invitations = Array.isArray(invitations) ? invitations : [];
    renderInvitations();
  } catch (error) {
    setStatus(invitationStatus, error.message, 'error');
  }
}

async function deleteInvitation(invitationId) {
  if (!state.currentRoom) return;
  try {
    await apiFetch(
      `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/invitations/${invitationId}`,
      { method: 'DELETE' },
    );
    setStatus(invitationStatus, 'Приглашение удалено', 'success');
    await refreshInvitations();
  } catch (error) {
    setStatus(invitationStatus, error.message, 'error');
  }
}

function updateRoleSelectors() {
  const roles = Array.isArray(state.roleHierarchy) && state.roleHierarchy.length
    ? state.roleHierarchy.map((entry) => entry.role)
    : ['owner', 'admin', 'member', 'guest'];
  const uniqueRoles = [...new Set(roles)];
  const selects = [memberRoleSelect, roleLevelSelect];
  selects.forEach((select) => {
    if (!select) return;
    const previous = select.value;
    select.innerHTML = '';
    uniqueRoles.forEach((role) => {
      const option = document.createElement('option');
      option.value = role;
      option.textContent = formatRole(role);
      select.appendChild(option);
    });
    if (previous && uniqueRoles.includes(previous)) {
      select.value = previous;
    }
  });
}

function renderRoleHierarchy() {
  if (!roleHierarchyList) return;
  roleHierarchyList.innerHTML = '';
  const hierarchy = Array.isArray(state.roleHierarchy)
    ? state.roleHierarchy.slice().sort((a, b) => b.level - a.level)
    : [];
  if (!hierarchy.length) {
    const empty = document.createElement('li');
    empty.className = 'role-empty';
    empty.textContent = 'Иерархия ролей не настроена.';
    roleHierarchyList.appendChild(empty);
    return;
  }

  hierarchy.forEach((entry) => {
    const item = document.createElement('li');
    item.className = 'role-item';
    const name = document.createElement('span');
    name.className = 'role-name';
    name.textContent = formatRole(entry.role);
    const value = document.createElement('span');
    value.className = 'role-level';
    value.textContent = `Уровень ${entry.level}`;
    item.append(name, value);
    roleHierarchyList.appendChild(item);
  });
}

async function refreshRoleHierarchy() {
  if (!state.currentRoom || !isAdminRole(state.currentRole)) return;
  try {
    const hierarchy = await apiFetch(
      `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/roles/hierarchy`,
    );
    state.roleHierarchy = Array.isArray(hierarchy) ? hierarchy : [];
    updateRoleSelectors();
    renderRoleHierarchy();
  } catch (error) {
    setStatus(roleLevelStatus, error.message, 'error');
  }
}

function updateChannelAdminTools() {
  if (!channelAdmin) return;
  const isAdmin = isAdminRole(state.currentRole);
  if (!isAdmin || !state.currentChannel) {
    channelAdmin.hidden = true;
    clearStatus(channelCategoryStatus);
    if (channelCategoryAssign) {
      channelCategoryAssign.value = '';
    }
    return;
  }

  channelAdmin.hidden = false;
  updateCategorySelectOptions();
  if (channelCategoryAssign) {
    channelCategoryAssign.value = state.currentChannel.category_id
      ? String(state.currentChannel.category_id)
      : '';
  }
}

function resetWorkspaceView() {
  state.currentRoom = null;
  state.currentChannel = null;
  state.categories = [];
  state.invitations = [];
  state.roleHierarchy = [];
  state.currentRole = null;
  roomSummary.hidden = true;
  toggleChannelManagement(false);
  toggleCategoryManagement(false);
  toggleInvitationManagement(false);
  toggleRoleManagement(false);
  toggleOwnerRoleControls(false);
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

  const categoryNames = new Map();
  state.categories.forEach((category) => {
    categoryNames.set(category.id, category.name);
  });

  room.channels
    .slice()
    .sort((a, b) => a.letter.localeCompare(b.letter))
    .forEach((channel) => {
      const card = document.createElement('article');
      card.className = 'channel-card';
      card.dataset.channelLetter = channel.letter;
      card.dataset.channelId = channel.id;
      card.dataset.channelType = channel.type;
      if (channel.category_id) {
        card.dataset.categoryId = String(channel.category_id);
      }

      const typeRow = document.createElement('div');
      typeRow.className = 'channel-type';
      typeRow.textContent = formatChannelType(channel.type);

      const title = document.createElement('div');
      title.className = 'channel-name';
      title.textContent = `${channel.letter} · ${channel.name}`;

      const description = document.createElement('div');
      description.className = 'channel-description';
      const categoryName = channel.category_id ? categoryNames.get(channel.category_id) : null;
      description.textContent = categoryName
        ? `Категория: ${categoryName}. Откройте, чтобы просмотреть детали и подключиться.`
        : 'Без категории. Откройте, чтобы просмотреть детали и подключиться.';

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
  updateChannelAdminTools();
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
  const categoryName = channel.category_id
    ? state.categories.find((item) => item.id === channel.category_id)?.name
    : null;
  channelHint.textContent = categoryName
    ? `Канал ${channel.letter} · категория ${categoryName}`
    : `Канал ${channel.letter} комнаты ${state.currentRoom.title}`;
  channelTypePill.textContent = formatChannelType(channel.type);

  updateChannelActiveState();
  updatePlaceholder();
  updateChannelAdminTools();

  if (channel.type === 'text') {
    voiceChat.hidden = true;
    setupTextChannel(channel);
  } else {
    textChat.hidden = true;
    setupVoiceChannel(channel);
  }
}

function disconnectChat() {
  stopSelfTyping();
  if (state.chatSocket) {
    state.chatSocket.close();
    state.chatSocket = null;
  }
  resetTypingState();
  resetPresenceState();
  state.chat.messages = [];
  state.chat.attachments = [];
  state.chat.threadRootId = null;
  state.chat.threadMessages = [];
  state.chat.searchResults = [];
  state.chat.searchVisible = false;
  clearReplyTarget();
  renderPendingAttachments();
  renderThreadPanel();
  renderSearchResults();
  chatHistory.innerHTML = '';
  chatInput.value = '';
  chatInput.disabled = true;
  chatSend.disabled = true;
  chatDisconnect.disabled = true;
  if (chatAttachmentInput) {
    chatAttachmentInput.disabled = true;
  }
  chatSearchPanel?.setAttribute('hidden', 'true');
  textChat?.classList.remove('text-chat--with-thread');
  setStatus(chatStatus, 'Нет активного соединения');
}

function getMessageById(messageId) {
  return state.chat.messages.find((item) => item.id === messageId) || null;
}

function normalizeMessages(messages = []) {
  return messages
    .slice()
    .sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime();
      const bTime = new Date(b.created_at || 0).getTime();
      if (aTime === bTime) {
        return (a.id || 0) - (b.id || 0);
      }
      return aTime - bTime;
    });
}

function renderReplyPreview() {
  if (!chatReplyPreview) {
    return;
  }
  const target =
    state.chat.replyMessage ||
    getMessageById(state.chat.replyParentId || 0) ||
    state.chat.threadMessages.find((message) => message.id === state.chat.replyParentId) ||
    null;

  if (!target) {
    chatReplyPreview.hidden = true;
    if (chatReplyTarget) chatReplyTarget.textContent = '';
    if (chatReplyPreviewText) chatReplyPreviewText.textContent = '';
    return;
  }

  state.chat.replyParentId = target.id;
  state.chat.replyMessage = target;

  if (chatReplyTarget) {
    chatReplyTarget.textContent = `#${target.id}`;
  }
  if (chatReplyPreviewText) {
    const snippet = String(target.content ?? '').trim().slice(0, 80);
    chatReplyPreviewText.textContent = snippet || '—';
  }
  chatReplyPreview.hidden = false;
}

function clearReplyTarget() {
  state.chat.replyParentId = null;
  state.chat.replyMessage = null;
  renderReplyPreview();
}

function startReplyToMessage(message) {
  state.chat.replyParentId = message.id;
  state.chat.replyMessage = message;
  renderReplyPreview();
  const rootId = message.thread_root_id || message.id;
  if (!state.chat.threadRootId || state.chat.threadRootId !== rootId) {
    void openThread(rootId);
  }
  chatInput?.focus();
}

function showMessageInHistory(messageId) {
  const element = chatHistory?.querySelector(`[data-message-id="${messageId}"]`);
  if (!element) {
    setStatus(chatStatus, 'Сообщение отсутствует в текущей истории', 'info');
    return;
  }
  element.classList.add('chat-item--highlight');
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => {
    element.classList.remove('chat-item--highlight');
  }, 1600);
}

function isImageAttachment(attachment) {
  return Boolean(attachment?.content_type && attachment.content_type.startsWith('image/'));
}

function createAttachmentElement(attachment) {
  const item = document.createElement('li');
  item.className = 'message-attachment';
  const url = resolveApiUrl(attachment.download_url).toString();

  if (isImageAttachment(attachment)) {
    const figure = document.createElement('figure');
    figure.className = 'attachment-preview';
    const img = document.createElement('img');
    img.src = url;
    img.alt = attachment.file_name;
    img.loading = 'lazy';
    figure.appendChild(img);
    const caption = document.createElement('figcaption');
    caption.textContent = attachment.file_name;
    figure.appendChild(caption);
    item.appendChild(figure);
  } else {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const sizeLabel = attachment.file_size
      ? `${Math.max(1, Math.round(Number(attachment.file_size) / 1024))} КБ`
      : '';
    link.textContent = sizeLabel ? `${attachment.file_name} (${sizeLabel})` : attachment.file_name;
    item.appendChild(link);
  }

  return item;
}

function buildMessageNode(message, { inThread = false } = {}) {
  const item = document.createElement('article');
  item.className = 'chat-item';
  item.dataset.messageId = String(message.id);

  if (state.chat.threadRootId && (message.thread_root_id || message.id) === state.chat.threadRootId) {
    item.classList.add('chat-item--active-thread');
  }

  const meta = document.createElement('header');
  meta.className = 'chat-meta';
  const author = document.createElement('span');
  author.className = 'chat-author';
  author.textContent = message.author_id ? `#${message.author_id}` : 'Система';
  const time = document.createElement('time');
  time.className = 'chat-timestamp';
  time.dateTime = message.created_at;
  time.textContent = formatDate(new Date(message.created_at ?? Date.now()));
  meta.append(author, time);
  item.append(meta);

  if (message.parent_id) {
    const replyInfo = document.createElement('button');
    replyInfo.type = 'button';
    replyInfo.className = 'chat-reply-link';
    replyInfo.textContent = `↩ #${message.parent_id}`;
    replyInfo.addEventListener('click', () => showMessageInHistory(message.parent_id));
    item.append(replyInfo);
  }

  const content = document.createElement('div');
  content.className = 'message-content';
  const lines = String(message.content ?? '').split(/\n+/);
  lines.forEach((line, index) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    if (!line && index === lines.length - 1) {
      paragraph.classList.add('message-content--empty');
    }
    content.appendChild(paragraph);
  });
  item.append(content);

  if (Array.isArray(message.attachments) && message.attachments.length) {
    const attachmentsList = document.createElement('ul');
    attachmentsList.className = 'message-attachments';
    message.attachments.forEach((attachment) => {
      attachmentsList.appendChild(createAttachmentElement(attachment));
    });
    item.append(attachmentsList);
  }

  const controls = document.createElement('footer');
  controls.className = 'message-controls';

  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const replyButton = document.createElement('button');
  replyButton.type = 'button';
  replyButton.className = 'ghost';
  replyButton.textContent = 'Ответить';
  replyButton.addEventListener('click', () => startReplyToMessage(message));
  actions.appendChild(replyButton);

  if (!inThread) {
    const threadButton = document.createElement('button');
    threadButton.type = 'button';
    threadButton.className = 'ghost';
    const totalReplies = Number(message.thread_reply_count || 0);
    threadButton.textContent = totalReplies > 0 ? `Тред (${totalReplies})` : 'Открыть тред';
    threadButton.addEventListener('click', () => {
      const rootId = message.thread_root_id || message.id;
      void openThread(rootId);
    });
    actions.appendChild(threadButton);
  }

  controls.appendChild(actions);

  const reactionsWrapper = document.createElement('div');
  reactionsWrapper.className = 'message-reactions';

  if (Array.isArray(message.reactions) && message.reactions.length) {
    const reactionList = document.createElement('div');
    reactionList.className = 'reaction-list';
    message.reactions.forEach((reaction) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'reaction-pill';
      button.dataset.emoji = reaction.emoji;
      button.textContent = `${reaction.emoji} ${reaction.count}`;
      if (state.currentUserId && reaction.user_ids?.includes(state.currentUserId)) {
        button.classList.add('reaction-pill--active');
      }
      button.addEventListener('click', () => toggleReaction(message.id, reaction.emoji));
      reactionList.appendChild(button);
    });
    reactionsWrapper.appendChild(reactionList);
  }

  const quickBar = document.createElement('div');
  quickBar.className = 'reaction-quick';
  QUICK_REACTIONS.forEach((emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reaction-quick-button';
    button.textContent = emoji;
    button.addEventListener('click', () => toggleReaction(message.id, emoji));
    quickBar.appendChild(button);
  });
  reactionsWrapper.appendChild(quickBar);
  controls.appendChild(reactionsWrapper);

  item.append(controls);
  return item;
}

function renderChatMessages({ scrollToEnd = false } = {}) {
  if (!chatHistory) {
    return;
  }

  const isAtBottom =
    chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight < 24;

  chatHistory.innerHTML = '';
  state.chat.messages.forEach((message) => {
    chatHistory.appendChild(buildMessageNode(message));
  });

  if (scrollToEnd || isAtBottom) {
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }
}

function updateSearchResultsWithMessage(message) {
  if (!Array.isArray(state.chat.searchResults) || !state.chat.searchResults.length) {
    return;
  }
  const index = state.chat.searchResults.findIndex((item) => item.id === message.id);
  if (index !== -1) {
    state.chat.searchResults[index] = message;
    renderSearchResults();
  }
}

function upsertChatMessage(message, { scrollToEnd = false } = {}) {
  const existingIndex = state.chat.messages.findIndex((item) => item.id === message.id);
  if (existingIndex !== -1) {
    state.chat.messages[existingIndex] = message;
  } else {
    state.chat.messages.push(message);
  }
  state.chat.messages = normalizeMessages(state.chat.messages);
  renderChatMessages({ scrollToEnd });
  updateThreadWithMessage(message);
  updateSearchResultsWithMessage(message);
}

function setChatMessages(messages, { scrollToEnd = false } = {}) {
  state.chat.messages = normalizeMessages(Array.isArray(messages) ? messages : []);
  renderChatMessages({ scrollToEnd });
  renderThreadPanel();
}

function renderThreadPanel() {
  if (!chatThreadPanel) {
    return;
  }
  if (!state.chat.threadRootId) {
    chatThreadPanel.hidden = true;
    chatThreadList.innerHTML = '';
    return;
  }

  chatThreadPanel.hidden = false;
  const rootMessage =
    state.chat.threadMessages.find((item) => item.id === state.chat.threadRootId) ||
    getMessageById(state.chat.threadRootId);
  if (chatThreadTitle) {
    chatThreadTitle.textContent = rootMessage
      ? `Тред #${rootMessage.id}`
      : `Тред #${state.chat.threadRootId}`;
  }
  chatThreadList.innerHTML = '';
  normalizeMessages(state.chat.threadMessages).forEach((message) => {
    chatThreadList.appendChild(buildMessageNode(message, { inThread: true }));
  });
}

function updateThreadWithMessage(message) {
  if (!state.chat.threadRootId) {
    return;
  }
  const rootId = message.thread_root_id || message.id;
  if (rootId !== state.chat.threadRootId) {
    return;
  }
  const existingIndex = state.chat.threadMessages.findIndex((item) => item.id === message.id);
  if (existingIndex !== -1) {
    state.chat.threadMessages[existingIndex] = message;
  } else {
    state.chat.threadMessages.push(message);
  }
  state.chat.threadMessages = normalizeMessages(state.chat.threadMessages);
  renderThreadPanel();
  if (state.chat.replyParentId === message.id) {
    state.chat.replyMessage = message;
    renderReplyPreview();
  }
}

async function openThread(rootMessageId) {
  if (!state.currentChannel) {
    setStatus(chatStatus, 'Выберите канал для работы с тредами', 'error');
    return;
  }
  try {
    const messages = await apiFetch(`/api/channels/${state.currentChannel.id}/threads/${rootMessageId}`);
    state.chat.threadRootId = rootMessageId;
    state.chat.threadMessages = Array.isArray(messages) ? messages : [];
    const rootMessage =
      state.chat.threadMessages.find((item) => item.id === rootMessageId) ||
      getMessageById(rootMessageId);
    state.chat.replyParentId = rootMessage ? rootMessage.id : rootMessageId;
    state.chat.replyMessage = rootMessage || null;
    renderReplyPreview();
    renderThreadPanel();
    textChat?.classList.add('text-chat--with-thread');
  } catch (error) {
    setStatus(chatStatus, error.message || 'Не удалось загрузить тред', 'error');
  }
}

function closeThread() {
  state.chat.threadRootId = null;
  state.chat.threadMessages = [];
  textChat?.classList.remove('text-chat--with-thread');
  clearReplyTarget();
  renderThreadPanel();
}

function toggleReaction(messageId, emoji) {
  if (!state.chatSocket || state.chatSocket.readyState !== WebSocket.OPEN) {
    setStatus(chatStatus, 'WebSocket не подключен', 'error');
    return;
  }
  if (!state.currentUserId) {
    setStatus(chatStatus, 'Не удалось определить пользователя для реакции', 'error');
    return;
  }
  const message = getMessageById(messageId) ||
    state.chat.threadMessages.find((item) => item.id === messageId);
  const existingReaction = message?.reactions?.find(
    (reaction) => reaction.emoji === emoji && reaction.user_ids?.includes(state.currentUserId),
  );
  const operation = existingReaction ? 'remove' : 'add';
  state.chatSocket.send(
    JSON.stringify({ type: 'reaction', message_id: messageId, emoji, operation }),
  );
}

function handleChatPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  if (payload.type === 'history' && Array.isArray(payload.messages)) {
    setChatMessages(payload.messages, { scrollToEnd: true });
    return;
  }
  if (payload.type === 'message' && payload.message) {
    upsertChatMessage(payload.message, { scrollToEnd: true });
    return;
  }
  if (payload.type === 'reaction' && payload.message) {
    upsertChatMessage(payload.message, { scrollToEnd: false });
    return;
  }
  if (payload.type === 'presence' && payload.channel_id) {
    applyPresencePayload(payload);
    return;
  }
  if (payload.type === 'typing' && payload.channel_id) {
    applyTypingPayload(payload);
    return;
  }
  if (payload.type === 'error' && payload.detail) {
    setStatus(chatStatus, payload.detail, 'error');
  }
}

function resetPresenceState() {
  state.chat.onlineUsers = [];
  renderPresenceIndicator();
}

function renderPresenceIndicator() {
  if (!chatPresence || !chatPresenceText) {
    return;
  }
  const channelId = state.currentChannel?.id;
  const users = Array.isArray(state.chat.onlineUsers) ? state.chat.onlineUsers : [];
  if (!channelId || users.length === 0) {
    chatPresence.hidden = true;
    chatPresenceText.textContent = '';
    return;
  }

  const currentId = state.currentUserId;
  const others = [];
  let includeSelf = false;
  users.forEach((user) => {
    if (!user) return;
    const userId = typeof user.id === 'number' ? user.id : Number(user.id);
    const displayName = user.display_name || user.displayName || `Участник #${userId}`;
    if (Number.isFinite(userId) && currentId && userId === currentId) {
      includeSelf = true;
    } else {
      others.push(displayName);
    }
  });

  const parts = [];
  if (includeSelf) {
    parts.push('Вы');
  }
  if (others.length) {
    parts.push(...others);
  }

  if (parts.length === 0) {
    chatPresence.hidden = true;
    chatPresenceText.textContent = '';
    return;
  }

  chatPresence.hidden = false;
  chatPresenceText.textContent = `В сети: ${parts.join(', ')}`;
}

function applyPresencePayload(payload) {
  if (!state.currentChannel || payload.channel_id !== state.currentChannel.id) {
    return;
  }
  const list = Array.isArray(payload.online) ? payload.online : [];
  state.chat.onlineUsers = list
    .map((user) => {
      if (!user) return null;
      const id = typeof user.id === 'number' ? user.id : Number(user.id);
      if (!Number.isFinite(id)) return null;
      return {
        id,
        display_name: user.display_name || user.displayName || `Участник #${id}`,
      };
    })
    .filter(Boolean);
  renderPresenceIndicator();
}

function resetTypingState() {
  if (state.chat.typingCleanupTimer) {
    window.clearTimeout(state.chat.typingCleanupTimer);
    state.chat.typingCleanupTimer = null;
  }
  state.chat.typingUsers = new Map();
  renderTypingIndicator();
}

function renderTypingIndicator() {
  if (!chatTyping || !chatTypingText) {
    return;
  }
  const now = Date.now();
  const labels = [];
  state.chat.typingUsers.forEach((value, userId) => {
    if (!value || typeof value.expiresAt !== 'number') {
      return;
    }
    if (value.expiresAt <= now) {
      return;
    }
    const label = userId === state.currentUserId ? 'Вы' : value.displayName;
    labels.push(label);
  });

  if (!labels.length) {
    chatTyping.hidden = true;
    chatTypingText.textContent = '';
    return;
  }

  chatTyping.hidden = false;
  const text =
    labels.length === 1
      ? `${labels[0]} печатает...`
      : `${labels.slice(0, 3).join(', ')} печатают...`;
  chatTypingText.textContent = text;
}

function scheduleTypingCleanup() {
  if (state.chat.typingCleanupTimer) {
    window.clearTimeout(state.chat.typingCleanupTimer);
    state.chat.typingCleanupTimer = null;
  }
  if (!(state.chat.typingUsers instanceof Map) || state.chat.typingUsers.size === 0) {
    renderTypingIndicator();
    return;
  }

  const now = Date.now();
  let nextDelay = Infinity;
  for (const [userId, value] of state.chat.typingUsers.entries()) {
    if (!value || typeof value.expiresAt !== 'number' || value.expiresAt <= now) {
      state.chat.typingUsers.delete(userId);
    } else {
      const remaining = value.expiresAt - now;
      if (remaining < nextDelay) {
        nextDelay = remaining;
      }
    }
  }

  renderTypingIndicator();
  if (state.chat.typingUsers.size === 0) {
    return;
  }

  const delay = Math.max(250, Math.min(nextDelay, 5000));
  state.chat.typingCleanupTimer = window.setTimeout(() => {
    scheduleTypingCleanup();
  }, delay);
}

function applyTypingPayload(payload) {
  if (!state.currentChannel || payload.channel_id !== state.currentChannel.id) {
    return;
  }
  const ttlSeconds = Number(payload.expires_in ?? 5);
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 5000;
  const now = Date.now();
  const users = Array.isArray(payload.users) ? payload.users : [];
  const entries = new Map();
  users.forEach((user) => {
    if (!user) return;
    const id = typeof user.id === 'number' ? user.id : Number(user.id);
    if (!Number.isFinite(id)) {
      return;
    }
    const displayName = user.display_name || user.displayName || `Участник #${id}`;
    entries.set(id, { displayName, expiresAt: now + ttlMs });
  });
  state.chat.typingUsers = entries;
  scheduleTypingCleanup();
}

function sendTypingStatus(isTyping) {
  if (!state.chatSocket || state.chatSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    state.chatSocket.send(
      JSON.stringify({ type: 'typing', is_typing: Boolean(isTyping) })
    );
  } catch (error) {
    console.warn('Failed to send typing indicator', error);
  }
}

function stopSelfTyping({ notify = true } = {}) {
  if (state.chat.selfTypingTimeout) {
    window.clearTimeout(state.chat.selfTypingTimeout);
    state.chat.selfTypingTimeout = null;
  }
  if (
    notify &&
    state.chat.selfTypingActive &&
    state.chatSocket &&
    state.chatSocket.readyState === WebSocket.OPEN
  ) {
    sendTypingStatus(false);
  }
  state.chat.selfTypingActive = false;
}

function handleTypingInput() {
  if (!chatInput || chatInput.disabled) {
    stopSelfTyping({ notify: false });
    return;
  }
  if (!state.chatSocket || state.chatSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  const text = chatInput.value.trim();
  if (!text) {
    stopSelfTyping();
    return;
  }

  if (!state.chat.selfTypingActive) {
    sendTypingStatus(true);
    state.chat.selfTypingActive = true;
  }

  if (state.chat.selfTypingTimeout) {
    window.clearTimeout(state.chat.selfTypingTimeout);
  }
  state.chat.selfTypingTimeout = window.setTimeout(() => {
    stopSelfTyping();
  }, 3500);
}

function renderPendingAttachments() {
  if (!chatAttachmentList) {
    return;
  }
  chatAttachmentList.innerHTML = '';
  if (!state.chat.attachments.length) {
    chatAttachmentList.classList.add('chat-attachments--empty');
    return;
  }
  chatAttachmentList.classList.remove('chat-attachments--empty');
  state.chat.attachments.forEach((attachment) => {
    const item = document.createElement('li');
    item.className = 'pending-attachment';
    item.dataset.attachmentId = String(attachment.id);
    const name = document.createElement('span');
    name.className = 'pending-attachment__name';
    name.textContent = attachment.file_name;
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'ghost';
    removeButton.textContent = 'Удалить';
    removeButton.addEventListener('click', () => removePendingAttachment(attachment.id));
    item.append(name, removeButton);
    chatAttachmentList.appendChild(item);
  });
}

function removePendingAttachment(attachmentId) {
  state.chat.attachments = state.chat.attachments.filter((item) => item.id !== attachmentId);
  renderPendingAttachments();
}

function clearPendingAttachments() {
  state.chat.attachments = [];
  if (chatAttachmentInput) {
    chatAttachmentInput.value = '';
  }
  renderPendingAttachments();
}

async function uploadChatAttachment(file) {
  if (!state.currentChannel) {
    throw new Error('Сначала выберите канал');
  }
  const url = resolveApiUrl(`/api/channels/${state.currentChannel.id}/attachments`);
  const formData = new FormData();
  formData.append('file', file, file.name);

  const headers = new Headers();
  if (state.token) {
    headers.set('Authorization', `Bearer ${state.token}`);
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    let message = response.statusText || 'Не удалось загрузить файл';
    try {
      const data = await response.json();
      if (data && typeof data.detail === 'string') {
        message = data.detail;
      }
    } catch (error) {
      // ignore parse errors
    }
    throw new Error(message);
  }

  return response.json();
}

async function handleAttachmentSelection(event) {
  const files = Array.from(event.target?.files || []);
  if (!files.length) {
    return;
  }
  for (const file of files) {
    try {
      const metadata = await uploadChatAttachment(file);
      state.chat.attachments.push(metadata);
      renderPendingAttachments();
    } catch (error) {
      setStatus(chatStatus, error.message || 'Ошибка загрузки вложения', 'error');
      break;
    }
  }
  if (chatAttachmentInput) {
    chatAttachmentInput.value = '';
  }
}

function toggleSearchPanel(force) {
  const next = typeof force === 'boolean' ? force : !state.chat.searchVisible;
  state.chat.searchVisible = next;
  if (chatSearchPanel) {
    chatSearchPanel.hidden = !next;
  }
  if (next) {
    chatSearchQueryInput?.focus();
  }
}

function renderSearchResults() {
  if (!chatSearchResults) {
    return;
  }
  chatSearchResults.innerHTML = '';
  if (!state.chat.searchResults.length) {
    const empty = document.createElement('p');
    empty.className = 'search-empty';
    empty.textContent = 'Нет результатов';
    chatSearchResults.appendChild(empty);
    return;
  }
  state.chat.searchResults.forEach((message) => {
    const item = document.createElement('article');
    item.className = 'search-result';
    item.dataset.messageId = String(message.id);

    const header = document.createElement('header');
    header.className = 'search-result__meta';
    const author = document.createElement('span');
    author.textContent = message.author_id ? `#${message.author_id}` : 'Система';
    const time = document.createElement('time');
    time.dateTime = message.created_at;
    time.textContent = formatDate(new Date(message.created_at ?? Date.now()));
    header.append(author, time);

    const preview = document.createElement('p');
    preview.className = 'search-result__preview';
    preview.textContent = String(message.content ?? '').slice(0, 140) || '—';

    const actions = document.createElement('div');
    actions.className = 'search-result__actions';
    const focusButton = document.createElement('button');
    focusButton.type = 'button';
    focusButton.className = 'ghost';
    focusButton.textContent = 'Показать';
    focusButton.addEventListener('click', () => {
      toggleSearchPanel(false);
      const present = getMessageById(message.id);
      if (present) {
        showMessageInHistory(message.id);
      } else {
        void openThread(message.thread_root_id || message.id).then(() => {
          showMessageInHistory(message.id);
        });
      }
    });
    const threadButton = document.createElement('button');
    threadButton.type = 'button';
    threadButton.className = 'ghost';
    threadButton.textContent = 'Тред';
    threadButton.addEventListener('click', () => {
      toggleSearchPanel(false);
      void openThread(message.thread_root_id || message.id);
    });
    actions.append(focusButton, threadButton);

    item.append(header, preview, actions);
    chatSearchResults.appendChild(item);
  });
}

async function performChatSearch(event) {
  event.preventDefault();
  if (!state.currentChannel) {
    setStatus(chatStatus, 'Сначала выберите канал', 'error');
    return;
  }
  const params = new URLSearchParams();
  const query = chatSearchQueryInput?.value.trim();
  const authorValue = chatSearchAuthorInput?.value.trim();
  const hasAttachments = chatSearchAttachmentSelect?.value;
  const startValue = chatSearchStartInput?.value;
  const endValue = chatSearchEndInput?.value;

  if (query) params.set('query', query);
  if (authorValue) {
    const authorId = Number(authorValue);
    if (!Number.isNaN(authorId)) {
      params.set('author_id', String(authorId));
    }
  }
  if (hasAttachments === 'yes') params.set('has_attachments', 'true');
  if (hasAttachments === 'no') params.set('has_attachments', 'false');

  if (startValue) {
    const startDate = new Date(startValue);
    if (!Number.isNaN(startDate.getTime())) {
      params.set('start', startDate.toISOString());
    }
  }
  if (endValue) {
    const endDate = new Date(endValue);
    if (!Number.isNaN(endDate.getTime())) {
      params.set('end', endDate.toISOString());
    }
  }

  try {
    const url = `/api/channels/${state.currentChannel.id}/search?${params.toString()}`;
    const results = await apiFetch(url);
    state.chat.searchResults = Array.isArray(results) ? results : [];
    renderSearchResults();
  } catch (error) {
    setStatus(chatStatus, error.message, 'error');
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
    if (chatAttachmentInput) {
      chatAttachmentInput.disabled = false;
    }
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
    stopSelfTyping({ notify: false });
    resetTypingState();
    resetPresenceState();
    setStatus(chatStatus, 'Соединение закрыто');
    chatInput.disabled = true;
    chatSend.disabled = true;
    chatDisconnect.disabled = true;
    if (chatAttachmentInput) {
      chatAttachmentInput.disabled = true;
    }
    clearPendingAttachments();
  });

  socket.addEventListener('error', () => {
    setStatus(chatStatus, 'Ошибка WebSocket', 'error');
  });
}

function setupTextChannel(channel) {
  disconnectChat();
  disconnectVoice();
  textChat.hidden = false;
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
    state.voice.pc.onconnectionstatechange = null;
    state.voice.pc.close();
    state.voice.pc = null;
  }
}

function stopQualityMonitor() {
  if (state.voice.qualityTimer) {
    window.clearInterval(state.voice.qualityTimer);
    state.voice.qualityTimer = null;
  }
}

function resetVoiceRenderState() {
  state.voice.participants = new Map();
  state.voice.qualityReports = new Map();
  state.voice.mediaStreams.forEach((entry) => {
    if (entry?.video instanceof MediaStream) {
      entry.video.getTracks().forEach((track) => track.stop());
    }
  });
  state.voice.mediaStreams = new Map();
  state.voice.videoElements.forEach((video) => {
    if (video && video.srcObject instanceof MediaStream) {
      video.srcObject.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
  });
  state.voice.videoElements = new Map();
  state.voice.self = {
    id: state.currentUserId,
    role: 'listener',
    muted: false,
    deafened: false,
    videoEnabled: false,
  };
  state.voice.enableVideo = false;
  state.voice.recordingActive = false;
  state.voice.stats = { ...DEFAULT_VOICE_STATS };
  if (voiceParticipantsGrid) {
    voiceParticipantsGrid.innerHTML = '';
  }
  if (voiceVideoWall) {
    voiceVideoWall.innerHTML = '';
  }
  if (voiceQualityList) {
    voiceQualityList.innerHTML = '';
  }
  renderVoiceParticipants();
  renderVoiceQuality();
  renderVideoTiles();
  updateVoiceControls();
  updateVoiceStatsUI();
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
  stopQualityMonitor();
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
  resetVoiceRenderState();
}

function sendVoiceBye(socket = state.voice.ws) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'signal', signal: { kind: 'bye' } }));
  }
}

async function ensureLocalStream() {
  const constraints = {
    audio: state.voice.selectedDeviceId
      ? { deviceId: { exact: state.voice.selectedDeviceId } }
      : true,
    video: state.voice.enableVideo
      ? state.voice.selectedCameraId
        ? { deviceId: { exact: state.voice.selectedCameraId } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } }
      : false,
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  if (state.voice.localStream) {
    state.voice.localStream.getTracks().forEach((track) => track.stop());
  }
  state.voice.localStream = stream;
  state.voice.mediaStreams.set(state.currentUserId, {
    video: state.voice.enableVideo ? stream : null,
  });
  const pc = ensurePeerConnection();
  const senders = pc.getSenders();
  stream.getTracks().forEach((track) => {
    const sender = senders.find((s) => s.track && s.track.kind === track.kind);
    if (sender) {
      sender.replaceTrack(track);
    } else {
      pc.addTrack(track, stream);
    }
  });
  if (!state.voice.enableVideo) {
    senders
      .filter((sender) => sender.track && sender.track.kind === 'video')
      .forEach((sender) => {
        pc.removeTrack(sender);
      });
  }
  renderVideoTiles();
  return stream;
}

function ensurePeerConnection() {
  if (state.voice.pc) {
    return state.voice.pc;
  }
  const pc = new RTCPeerConnection({ iceServers: getIceServers() });
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendVoiceSignal('candidate', { candidate: event.candidate });
    }
  };
  pc.ontrack = (event) => {
    if (event.track.kind === 'video') {
      const stream = event.streams?.[0] ?? new MediaStream([event.track]);
      const peerId = state.voice.lastSignalSenderId ?? 'remote';
      const entry = state.voice.mediaStreams.get(peerId) || {};
      entry.video = stream;
      state.voice.mediaStreams.set(peerId, entry);
      renderVideoTiles();
      return;
    }
    state.voice.remoteStream.addTrack(event.track);
    remoteAudio.srcObject = state.voice.remoteStream;
  };
  pc.onconnectionstatechange = () => {
    if (!state.voice.pc) {
      return;
    }
    if (['failed', 'disconnected'].includes(state.voice.pc.connectionState)) {
      setStatus(voiceStatus, 'Соединение с пэром потеряно', 'error');
    }
  };
  state.voice.pc = pc;
  if (state.voice.localStream) {
    state.voice.localStream
      .getTracks()
      .forEach((track) => pc.addTrack(track, state.voice.localStream));
  }
  startQualityMonitor();
  return pc;
}

async function populateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    if (micSelect) {
      micSelect.innerHTML = '<option value="">Микрофоны недоступны</option>';
      micSelect.disabled = true;
    }
    if (cameraSelect) {
      cameraSelect.innerHTML = '<option value="">Камеры недоступны</option>';
      cameraSelect.disabled = true;
    }
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((device) => device.kind === 'audioinput');
    const videoInputs = devices.filter((device) => device.kind === 'videoinput');

    if (micSelect) {
      micSelect.innerHTML = '';
      if (!audioInputs.length) {
        micSelect.innerHTML = '<option value="">Микрофоны не найдены</option>';
        micSelect.disabled = true;
        state.voice.selectedDeviceId = null;
      } else {
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
      }
    }

    if (cameraSelect) {
      cameraSelect.innerHTML = '';
      if (!videoInputs.length) {
        cameraSelect.innerHTML = '<option value="">Камеры не найдены</option>';
        cameraSelect.disabled = true;
        state.voice.selectedCameraId = null;
      } else {
        cameraSelect.disabled = false;
        cameraSelect.appendChild(new Option('По умолчанию', ''));
        videoInputs.forEach((device, index) => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `Камера ${index + 1}`;
          if (state.voice.selectedCameraId === device.deviceId) {
            option.selected = true;
          }
          cameraSelect.appendChild(option);
        });
      }
    }
  } catch (error) {
    console.error('Failed to enumerate devices', error);
    if (micSelect) {
      micSelect.innerHTML = '<option value="">Ошибка устройств</option>';
      micSelect.disabled = true;
    }
    if (cameraSelect) {
      cameraSelect.innerHTML = '<option value="">Ошибка устройств</option>';
      cameraSelect.disabled = true;
    }
  }
}

function setupVoiceChannel(channel) {
  disconnectChat();
  voiceChat.hidden = false;
  setStatus(voiceStatus, 'Готово к подключению');
  voiceConnect.disabled = false;
  voiceDisconnect.disabled = true;
  voiceStart.disabled = true;
  renderVoiceParticipants();
  renderVoiceQuality();
  renderVideoTiles();
  updateVoiceControls();
  updateVoiceStatsUI();
  void populateDevices();
}

function sendVoiceState(payload) {
  if (!state.voice.ws || state.voice.ws.readyState !== WebSocket.OPEN) {
    setStatus(voiceStatus, 'Сначала подключитесь к голосовому серверу', 'error');
    return false;
  }
  state.voice.ws.send(JSON.stringify({ type: 'state', ...payload }));
  return true;
}

function sendVoiceSignal(kind, signalPayload = {}) {
  if (!state.voice.ws || state.voice.ws.readyState !== WebSocket.OPEN) {
    setStatus(voiceStatus, 'Сначала подключитесь к голосовому серверу', 'error');
    return false;
  }
  state.voice.ws.send(
    JSON.stringify({ type: 'signal', signal: { kind, ...signalPayload } })
  );
  return true;
}

function participantDisplayName(participant) {
  return participant.displayName || `Участник #${participant.id}`;
}

function applyVoiceParticipants(participants, stats = null) {
  const map = new Map();
  participants.forEach((item) => {
    if (!item) {
      return;
    }
    const id = Number(item.id);
    if (!Number.isFinite(id)) {
      return;
    }
    map.set(id, {
      id,
      displayName: item.displayName || item.name || `Участник #${id}`,
      role: (item.role || 'listener').toLowerCase(),
      muted: Boolean(item.muted),
      deafened: Boolean(item.deafened),
      videoEnabled: Boolean(item.videoEnabled),
    });
  });
  state.voice.participants = map;
  state.voice.stats = normalizeVoiceStats(stats);
  const self = map.get(state.currentUserId ?? -1);
  if (self) {
    state.voice.self = { ...self };
    state.voice.enableVideo = Boolean(self.videoEnabled);
  }
  state.voice.mediaStreams.forEach((_, userId) => {
    if (!map.has(userId)) {
      state.voice.mediaStreams.delete(userId);
      state.voice.videoElements.delete(userId);
    }
  });
  renderVoiceParticipants();
  renderVideoTiles();
  updateVoiceControls();
  renderVoiceQuality();
  updateVoiceStatsUI();
}

function applyVoiceParticipantDelta(participant, stats = null) {
  if (!participant || typeof participant !== 'object') {
    return;
  }
  const id = Number(participant.id);
  if (!Number.isFinite(id)) {
    return;
  }
  const existing = state.voice.participants.get(id) || {
    id,
    displayName: participant.displayName || participant.name || `Участник #${id}`,
    role: 'listener',
    muted: false,
    deafened: false,
    videoEnabled: false,
  };
  const updated = {
    ...existing,
    displayName: participant.displayName || participant.name || existing.displayName,
    role: (participant.role || existing.role || 'listener').toLowerCase(),
    muted:
      participant.muted !== undefined ? Boolean(participant.muted) : Boolean(existing.muted),
    deafened:
      participant.deafened !== undefined
        ? Boolean(participant.deafened)
        : Boolean(existing.deafened),
    videoEnabled:
      participant.videoEnabled !== undefined
        ? Boolean(participant.videoEnabled)
        : Boolean(existing.videoEnabled),
  };
  state.voice.participants.set(id, updated);
  if (id === state.currentUserId) {
    state.voice.self = { ...updated };
    state.voice.enableVideo = Boolean(updated.videoEnabled);
  }
  if (stats) {
    mergeVoiceStats(stats);
  } else {
    updateVoiceStatsUI();
  }
  renderVoiceParticipants();
  renderVideoTiles();
  updateVoiceControls();
}

function renderVoiceParticipants() {
  if (!voiceParticipantsGrid) {
    return;
  }
  voiceParticipantsGrid.innerHTML = '';
  const participants = Array.from(state.voice.participants.values());
  if (!participants.length) {
    const empty = document.createElement('div');
    empty.className = 'voice-empty';
    empty.textContent = 'Подключитесь, чтобы увидеть участников.';
    voiceParticipantsGrid.appendChild(empty);
    return;
  }
  participants.forEach((participant) => {
    const card = document.createElement('article');
    card.className = 'voice-card';
    if (participant.role === 'speaker') {
      card.classList.add('voice-card--speaker');
    }
    if (participant.id === state.currentUserId) {
      card.classList.add('voice-card--self');
    }
    if (participant.muted) {
      card.classList.add('voice-card--muted');
    }
    if (participant.deafened) {
      card.classList.add('voice-card--deafened');
    }
    if (!participant.muted && !participant.deafened && participant.role === 'speaker') {
      card.classList.add('voice-card--active');
    }

    const media = document.createElement('div');
    media.className = 'voice-card__media';
    const avatar = document.createElement('div');
    avatar.className = 'voice-card__avatar';
    avatar.textContent = participantDisplayName(participant).slice(0, 1).toUpperCase();
    media.appendChild(avatar);

    const info = document.createElement('div');
    info.className = 'voice-card__info';
    const name = document.createElement('span');
    name.className = 'voice-card__name';
    name.textContent = participantDisplayName(participant);
    const role = document.createElement('span');
    role.className = 'voice-card__role';
    role.textContent = VOICE_ROLE_LABELS[participant.role] || 'Участник';
    info.appendChild(name);
    info.appendChild(role);
    media.appendChild(info);
    card.appendChild(media);

    const badges = document.createElement('div');
    badges.className = 'voice-card__badges';
    if (participant.muted) {
      const badge = document.createElement('span');
      badge.className = 'voice-badge voice-badge--mute';
      badge.textContent = 'Микрофон выкл.';
      badges.appendChild(badge);
    }
    if (participant.deafened) {
      const badge = document.createElement('span');
      badge.className = 'voice-badge voice-badge--deafen';
      badge.textContent = 'Звук выкл.';
      badges.appendChild(badge);
    }
    if (participant.videoEnabled) {
      const badge = document.createElement('span');
      badge.className = 'voice-badge';
      badge.textContent = 'Видео активно';
      badges.appendChild(badge);
    }
    if (badges.children.length) {
      card.appendChild(badges);
    }

    const activity = document.createElement('div');
    activity.className = 'voice-card__activity';
    card.appendChild(activity);

    voiceParticipantsGrid.appendChild(card);
  });
}

function renderVoiceQuality() {
  if (!voiceQualityPanel || !voiceQualityList) {
    return;
  }
  const entries = Array.from(state.voice.qualityReports.entries());
  if (!entries.length) {
    voiceQualityPanel.hidden = true;
    voiceQualityList.innerHTML = '';
    return;
  }
  voiceQualityPanel.hidden = false;
  voiceQualityList.innerHTML = '';
  entries.forEach(([userId, metrics]) => {
    const item = document.createElement('li');
    item.className = 'voice-quality-item';
    const participant = state.voice.participants.get(Number(userId));
    const name = participant ? participantDisplayName(participant) : `Участник #${userId}`;
    const summary = Object.entries(metrics || {})
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    const valueSpan = document.createElement('span');
    valueSpan.textContent = summary || '—';
    item.appendChild(nameSpan);
    item.appendChild(valueSpan);
    voiceQualityList.appendChild(item);
  });
}

function updateVoiceStatsUI() {
  if (!voiceStatsPanel) {
    return;
  }
  const stats = state.voice.stats || DEFAULT_VOICE_STATS;
  const total = Number.isFinite(stats.total) ? stats.total : 0;
  const speakers = Number.isFinite(stats.speakers) ? stats.speakers : 0;
  const listeners = Number.isFinite(stats.listeners) ? stats.listeners : 0;
  const active = Number.isFinite(stats.activeSpeakers) ? stats.activeSpeakers : 0;
  if (voiceTotalCount) {
    voiceTotalCount.textContent = String(total);
  }
  if (voiceSpeakerCount) {
    voiceSpeakerCount.textContent = String(speakers);
  }
  if (voiceListenerCount) {
    voiceListenerCount.textContent = String(listeners);
  }
  if (voiceActiveCount) {
    voiceActiveCount.textContent = String(active);
  }
  const shouldShow = state.voice.joined || total > 0 || speakers > 0 || listeners > 0;
  voiceStatsPanel.hidden = !shouldShow;
}

function renderVideoTiles() {
  if (!voiceVideoWall) {
    return;
  }
  voiceVideoWall.innerHTML = '';
  const participants = Array.from(state.voice.participants.values()).filter(
    (participant) => participant.videoEnabled
  );
  if (!participants.length) {
    return;
  }
  participants.forEach((participant) => {
    const tile = document.createElement('div');
    tile.className = 'voice-video-tile';
    if (participant.id === state.currentUserId) {
      tile.classList.add('voice-video-tile--self');
    }
    const label = document.createElement('div');
    label.className = 'voice-video-tile__label';
    label.textContent = participantDisplayName(participant);

    const entry = state.voice.mediaStreams.get(participant.id);
    const videoStream = entry?.video;
    if (videoStream instanceof MediaStream) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = participant.id === state.currentUserId;
      video.playsInline = true;
      video.srcObject = videoStream;
      tile.appendChild(video);
      tile.appendChild(label);
      voiceVideoWall.appendChild(tile);
      state.voice.videoElements.set(participant.id, video);
    } else {
      tile.classList.add('voice-video-tile--placeholder');
      const placeholder = document.createElement('div');
      placeholder.textContent = 'Видео подключается…';
      tile.appendChild(placeholder);
      tile.appendChild(label);
      voiceVideoWall.appendChild(tile);
    }
  });
}

function updateVoiceControls() {
  const joined = Boolean(state.voice.ws && state.voice.ws.readyState === WebSocket.OPEN);
  const canRecord = ['OWNER', 'ADMIN'].includes(String(state.currentRole || '').toUpperCase());
  if (voiceRoleToggle) {
    voiceRoleToggle.disabled = !joined;
    voiceRoleToggle.textContent =
      state.voice.self.role === 'speaker' ? 'Стать слушателем' : 'Стать спикером';
  }
  if (voiceMuteToggle) {
    voiceMuteToggle.disabled = !joined;
    voiceMuteToggle.textContent = state.voice.self.muted
      ? 'Включить микрофон'
      : 'Выключить микрофон';
  }
  if (voiceDeafenToggle) {
    voiceDeafenToggle.disabled = !joined;
    voiceDeafenToggle.textContent = state.voice.self.deafened
      ? 'Включить звук'
      : 'Выключить звук';
  }
  if (voiceVideoToggle) {
    voiceVideoToggle.disabled = !joined;
    voiceVideoToggle.textContent = state.voice.enableVideo
      ? 'Выключить видео'
      : 'Включить видео';
  }
  if (voiceRecordingToggle) {
    const recordingEnabled = state.config.webrtc.recording.enabled || state.voice.features.recording;
    voiceRecordingToggle.hidden = !recordingEnabled;
    voiceRecordingToggle.disabled = !joined || !canRecord;
    voiceRecordingToggle.textContent = state.voice.recordingActive
      ? 'Остановить запись'
      : 'Начать запись';
  }
}

async function collectPeerMetrics() {
  if (!state.voice.pc) {
    return null;
  }
  try {
    const stats = await state.voice.pc.getStats();
    let inboundAudio = null;
    let outboundAudio = null;
    stats.forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'audio') {
        inboundAudio = report;
      }
      if (report.type === 'outbound-rtp' && report.kind === 'audio') {
        outboundAudio = report;
      }
    });
    if (!inboundAudio && !outboundAudio) {
      return null;
    }
    const metrics = {};
    if (inboundAudio) {
      if (typeof inboundAudio.jitter === 'number') {
        metrics.jitter = Number(inboundAudio.jitter.toFixed(4));
      }
      if (typeof inboundAudio.packetsLost === 'number') {
        metrics.packetsLost = inboundAudio.packetsLost;
      }
    }
    if (outboundAudio) {
      const rtt = outboundAudio.roundTripTime ?? outboundAudio.totalRoundTripTime;
      if (typeof rtt === 'number') {
        metrics.roundTripTime = Number(rtt.toFixed(3));
      }
    }
    return metrics;
  } catch (error) {
    console.debug('Failed to collect WebRTC stats', error);
    return null;
  }
}

function startQualityMonitor() {
  stopQualityMonitor();
  const monitoringEnabled =
    state.config.webrtc.monitoring.enabled || state.voice.features.qualityMonitoring;
  if (!monitoringEnabled || !state.voice.pc) {
    return;
  }
  const intervalSeconds = Math.max(
    5,
    Number.parseInt(state.config.webrtc.monitoring.pollInterval, 10) || 15,
  );
  state.voice.qualityTimer = window.setInterval(async () => {
    const metrics = await collectPeerMetrics();
    if (metrics) {
      sendVoiceState({ event: 'quality-report', metrics });
    }
  }, intervalSeconds * 1000);
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
      state.voice.self.id = state.currentUserId;
      state.voice.features = {
        recording: Boolean(message.features?.recording ?? state.config.webrtc.recording.enabled),
        qualityMonitoring: Boolean(
          message.features?.qualityMonitoring ?? state.config.webrtc.monitoring.enabled,
        ),
      };
      setStatus(voiceStatus, 'Подключено. Можно начинать звонок.', 'success');
      voiceStart.disabled = false;
      updateVoiceControls();
      startQualityMonitor();
    }
    if (message.event === 'peer-joined' && message.user) {
      setStatus(voiceStatus, `${message.user.displayName || message.user.id} подключился`, 'success');
    }
    if (message.event === 'peer-left' && message.user) {
      setStatus(voiceStatus, `${message.user.displayName || message.user.id} отключился`);
    }
    return;
  }

  if (message.type === 'state') {
    switch (message.event) {
      case 'participants':
        applyVoiceParticipants(
          Array.isArray(message.participants) ? message.participants : [],
          message.stats,
        );
        break;
      case 'participant-updated':
        if (message.participant) {
          applyVoiceParticipantDelta(message.participant, message.stats);
        }
        break;
      case 'quality-update':
        if (Number.isFinite(message.userId) && typeof message.metrics === 'object') {
          state.voice.qualityReports.set(Number(message.userId), message.metrics);
          renderVoiceQuality();
        }
        break;
      case 'recording':
        state.voice.recordingActive = Boolean(message.active);
        updateVoiceControls();
        if (message.stats) {
          mergeVoiceStats(message.stats);
        }
        break;
      default:
        break;
    }
    return;
  }

  const signalPayload = message.signal || message;
  const kind =
    signalPayload?.kind || signalPayload?.type || signalPayload?.event || message.type || '';
  if (!kind) {
    return;
  }
  if (message.from?.id) {
    state.voice.lastSignalSenderId = Number(message.from.id);
  }

  const pc = ensurePeerConnection();

  switch (kind) {
    case 'offer':
      (async () => {
        await pc.setRemoteDescription(new RTCSessionDescription(signalPayload.description));
        if (!state.voice.localStream) {
          await ensureLocalStream();
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendVoiceSignal('answer', { description: pc.localDescription });
      })().catch((error) => {
        console.error('Failed to handle offer', error);
      });
      break;
    case 'answer':
      (async () => {
        await pc.setRemoteDescription(new RTCSessionDescription(signalPayload.description));
      })().catch((error) => {
        console.error('Failed to apply answer', error);
      });
      break;
    case 'candidate':
      if (signalPayload.candidate) {
        (async () => {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(signalPayload.candidate));
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
      renderVideoTiles();
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
  state.voice.self.id = state.currentUserId;

  socket.onopen = () => {
    setStatus(voiceStatus, 'Подключено. Запрашиваем устройства…');
    voiceConnect.disabled = true;
    voiceDisconnect.disabled = false;
    void populateDevices()
      .then(() => ensureLocalStream())
      .then(() => {
        setStatus(voiceStatus, 'Локальный поток готов. Можно начинать звонок.');
        voiceStart.disabled = false;
      })
      .catch((error) => {
        setStatus(voiceStatus, error.message || 'Не удалось получить доступ к устройствам', 'error');
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
    stopQualityMonitor();
    state.voice.joined = false;
    state.voice.ws = null;
    resetVoiceRenderState();
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
    sendVoiceSignal('offer', { description: pc.localDescription });
    setStatus(voiceStatus, 'Отправлен offer. Ожидаем ответ.', 'success');
  } catch (error) {
    setStatus(voiceStatus, error.message || 'Не удалось начать звонок', 'error');
  }
}

function toggleVoiceRole() {
  if (!state.currentUserId) {
    return;
  }
  const nextRole = state.voice.self.role === 'speaker' ? 'listener' : 'speaker';
  sendVoiceState({ event: 'set-role', role: nextRole, target: state.currentUserId });
}

function toggleVoiceMute() {
  if (!state.currentUserId) {
    return;
  }
  const next = !state.voice.self.muted;
  state.voice.self.muted = next;
  const entry = state.voice.participants.get(state.currentUserId);
  if (entry) {
    entry.muted = next;
    state.voice.participants.set(state.currentUserId, entry);
    renderVoiceParticipants();
  }
  updateVoiceControls();
  sendVoiceState({ event: 'set-muted', muted: next, target: state.currentUserId });
}

function toggleVoiceDeafen() {
  if (!state.currentUserId) {
    return;
  }
  const next = !state.voice.self.deafened;
  state.voice.self.deafened = next;
  const entry = state.voice.participants.get(state.currentUserId);
  if (entry) {
    entry.deafened = next;
    state.voice.participants.set(state.currentUserId, entry);
    renderVoiceParticipants();
  }
  updateVoiceControls();
  sendVoiceState({ event: 'set-deafened', deafened: next, target: state.currentUserId });
}

async function toggleVoiceVideo() {
  if (!navigator.mediaDevices) {
    setStatus(voiceStatus, 'Видео не поддерживается', 'error');
    return;
  }
  const nextState = !state.voice.enableVideo;
  const previousState = state.voice.enableVideo;
  state.voice.enableVideo = nextState;
  state.voice.self.videoEnabled = nextState;
  const entry = state.voice.participants.get(state.currentUserId);
  if (entry) {
    entry.videoEnabled = nextState;
    state.voice.participants.set(state.currentUserId, entry);
    renderVoiceParticipants();
    renderVideoTiles();
  }
  updateVoiceControls();
  try {
    await ensureLocalStream();
    sendVoiceState({ event: 'media', videoEnabled: state.voice.enableVideo });
  } catch (error) {
    state.voice.enableVideo = previousState;
    state.voice.self.videoEnabled = previousState;
    if (entry) {
      entry.videoEnabled = previousState;
      state.voice.participants.set(state.currentUserId, entry);
      renderVoiceParticipants();
      renderVideoTiles();
    }
    updateVoiceControls();
    setStatus(
      voiceStatus,
      error?.message || 'Не удалось обновить состояние видео',
      'error',
    );
  }
}

function toggleVoiceRecording() {
  sendVoiceState({ event: 'recording', active: !state.voice.recordingActive });
}

function handleChatSubmit(event) {
  event.preventDefault();
  if (!state.chatSocket || state.chatSocket.readyState !== WebSocket.OPEN) {
    setStatus(chatStatus, 'WebSocket не подключен', 'error');
    return;
  }
  const text = chatInput.value.trim();
  const attachmentIds = state.chat.attachments.map((item) => item.id);
  if (!text && attachmentIds.length === 0) {
    setStatus(chatStatus, 'Добавьте текст или вложение', 'error');
    return;
  }

  const payload = {
    type: 'message',
    content: text,
    attachments: attachmentIds,
  };
  if (state.chat.replyParentId) {
    payload.parent_id = state.chat.replyParentId;
  }

  state.chatSocket.send(JSON.stringify(payload));
  stopSelfTyping();
  chatInput.value = '';
  autoResizeTextarea(chatInput);
  if (state.chat.threadRootId) {
    const root =
      state.chat.threadMessages.find((item) => item.id === state.chat.threadRootId) ||
      getMessageById(state.chat.threadRootId);
    state.chat.replyParentId = root ? root.id : state.chat.threadRootId;
    state.chat.replyMessage = root || null;
    renderReplyPreview();
  } else {
    clearReplyTarget();
  }
  clearPendingAttachments();
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
    state.categories = Array.isArray(room.categories) ? room.categories : [];
    state.invitations = Array.isArray(room.invitations) ? room.invitations : [];
    state.roleHierarchy = Array.isArray(room.role_hierarchy) ? room.role_hierarchy : [];
    state.currentRole = room.current_role ?? null;
    setLastRoom(room.slug);
    updateRoomSummary();
    updateManagementSections();
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
    state.currentUserId = null;
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

  roomCreateForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = roomTitleInput.value.trim();
    if (!title) {
      setStatus(roomCreateStatus, 'Введите название комнаты', 'error');
      roomTitleInput.focus();
      return;
    }
    setStatus(roomCreateStatus, 'Создание комнаты…');
    roomCreateSubmit.disabled = true;
    try {
      const room = await apiFetch('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      setStatus(
        roomCreateStatus,
        `Комната «${room.title}» создана. Slug: ${room.slug}`,
        'success',
      );
      roomCreateForm.reset();
      if (roomSlugInput) {
        roomSlugInput.value = room.slug;
      }
      loadRoom(room.slug);
    } catch (error) {
      setStatus(roomCreateStatus, error.message, 'error');
    } finally {
      roomCreateSubmit.disabled = false;
    }
  });

  channelCreateForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.currentRoom) {
      setStatus(channelCreateStatus, 'Сначала загрузите комнату', 'error');
      return;
    }
    const name = channelNameInput.value.trim();
    const type = event.submitter?.dataset.channelType === 'voice' ? 'voice' : 'text';
    const categoryValue = channelCategorySelect?.value || '';
    const categoryId = categoryValue ? Number(categoryValue) : null;
    if (!name) {
      setStatus(channelCreateStatus, 'Введите название канала', 'error');
      channelNameInput.focus();
      return;
    }
    if (categoryValue && Number.isNaN(categoryId)) {
      setStatus(channelCreateStatus, 'Некорректная категория', 'error');
      return;
    }
    setStatus(channelCreateStatus, 'Создание канала…');
    channelCreateButtons.forEach((button) => {
      button.disabled = true;
    });
    try {
      const channel = await apiFetch(
        `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/channels`,
        {
          method: 'POST',
          body: JSON.stringify({
            name,
            type,
            category_id: categoryId !== null && !Number.isNaN(categoryId) ? categoryId : null,
          }),
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
      if (channelCategorySelect) {
        channelCategorySelect.value = '';
      }
      channelNameInput.focus();
      selectChannel(channel.letter);
    } catch (error) {
      setStatus(channelCreateStatus, error.message, 'error');
    } finally {
      channelCreateButtons.forEach((button) => {
        button.disabled = false;
      });
    }
  });

  categoryCreateForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.currentRoom) {
      setStatus(categoryManageStatus, 'Сначала загрузите комнату', 'error');
      return;
    }
    const name = categoryNameInput.value.trim();
    const positionValue = categoryPositionInput.value.trim();
    const position = positionValue ? Number(positionValue) : 0;
    if (!name) {
      setStatus(categoryManageStatus, 'Введите название категории', 'error');
      categoryNameInput.focus();
      return;
    }
    if (Number.isNaN(position)) {
      setStatus(categoryManageStatus, 'Позиция должна быть числом', 'error');
      categoryPositionInput.focus();
      return;
    }
    setStatus(categoryManageStatus, 'Создание категории…');
    try {
      await apiFetch(
        `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/categories`,
        {
          method: 'POST',
          body: JSON.stringify({ name, position }),
        },
      );
      setStatus(categoryManageStatus, 'Категория создана', 'success');
      categoryCreateForm.reset();
      await refreshCategories();
    } catch (error) {
      setStatus(categoryManageStatus, error.message, 'error');
    }
  });

  invitationCreateForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.currentRoom) {
      setStatus(invitationStatus, 'Сначала загрузите комнату', 'error');
      return;
    }
    const role = invitationRoleSelect?.value || 'member';
    const expiresValue = invitationExpiresInput?.value || '';
    let expiresAt = null;
    if (expiresValue) {
      const expiresDate = new Date(expiresValue);
      if (Number.isNaN(expiresDate.getTime())) {
        setStatus(invitationStatus, 'Укажите корректную дату', 'error');
        return;
      }
      expiresAt = expiresDate.toISOString();
    }
    setStatus(invitationStatus, 'Создание приглашения…');
    try {
      await apiFetch(
        `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/invitations`,
        {
          method: 'POST',
          body: JSON.stringify({ role, expires_at: expiresAt }),
        },
      );
      setStatus(invitationStatus, 'Приглашение создано', 'success');
      invitationCreateForm.reset();
      await refreshInvitations();
    } catch (error) {
      setStatus(invitationStatus, error.message, 'error');
    }
  });

  memberRoleForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.currentRoom) {
      setStatus(memberRoleStatus, 'Сначала загрузите комнату', 'error');
      return;
    }
    const userIdValue = memberRoleUserInput.value.trim();
    const userId = Number(userIdValue);
    if (!userIdValue || Number.isNaN(userId)) {
      setStatus(memberRoleStatus, 'Укажите ID участника', 'error');
      memberRoleUserInput.focus();
      return;
    }
    const role = memberRoleSelect?.value || 'member';
    setStatus(memberRoleStatus, 'Обновление роли…');
    try {
      await apiFetch(
        `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/members/${userId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ role }),
        },
      );
      setStatus(memberRoleStatus, 'Роль обновлена', 'success');
      memberRoleForm.reset();
    } catch (error) {
      setStatus(memberRoleStatus, error.message, 'error');
    }
  });

  roleLevelForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.currentRoom) {
      setStatus(roleLevelStatus, 'Сначала загрузите комнату', 'error');
      return;
    }
    const role = roleLevelSelect?.value;
    const levelValue = roleLevelInput.value.trim();
    const level = Number(levelValue);
    if (!role) {
      setStatus(roleLevelStatus, 'Выберите роль', 'error');
      return;
    }
    if (!levelValue || Number.isNaN(level)) {
      setStatus(roleLevelStatus, 'Укажите числовой уровень', 'error');
      roleLevelInput.focus();
      return;
    }
    setStatus(roleLevelStatus, 'Сохранение уровня…');
    try {
      await apiFetch(
        `/api/rooms/${encodeURIComponent(state.currentRoom.slug)}/roles/hierarchy/${encodeURIComponent(role)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ level }),
        },
      );
      setStatus(roleLevelStatus, 'Уровень обновлён', 'success');
      await refreshRoleHierarchy();
    } catch (error) {
      setStatus(roleLevelStatus, error.message, 'error');
    }
  });

  channelCategorySave?.addEventListener('click', async (event) => {
    event.preventDefault();
    if (!state.currentRoom || !state.currentChannel) {
      setStatus(channelCategoryStatus, 'Сначала выберите канал', 'error');
      return;
    }
    const value = channelCategoryAssign?.value || '';
    const categoryId = value ? Number(value) : null;
    if (value && Number.isNaN(categoryId)) {
      setStatus(channelCategoryStatus, 'Некорректная категория', 'error');
      return;
    }
    setStatus(channelCategoryStatus, 'Обновление категории…');
    channelCategorySave.disabled = true;
    try {
      const updatedChannel = await apiFetch(
        `/api/channels/${state.currentChannel.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ category_id: categoryId === null ? null : categoryId }),
        },
      );
      const channels = Array.isArray(state.currentRoom.channels)
        ? state.currentRoom.channels.slice()
        : [];
      const index = channels.findIndex((item) => item.id === updatedChannel.id);
      if (index !== -1) {
        channels[index] = updatedChannel;
      }
      state.currentRoom.channels = channels;
      state.currentChannel = updatedChannel;
      setStatus(channelCategoryStatus, 'Категория обновлена', 'success');
      updateChannelAdminTools();
      renderChannels(state.currentRoom);
      updateChannelActiveState();
    } catch (error) {
      setStatus(channelCategoryStatus, error.message, 'error');
    } finally {
      channelCategorySave.disabled = false;
    }
  });

  chatForm?.addEventListener('submit', handleChatSubmit);

  chatDisconnect?.addEventListener('click', () => {
    disconnectChat();
  });

  chatInput?.addEventListener('input', () => {
    autoResizeTextarea(chatInput);
    handleTypingInput();
  });
  chatInput?.addEventListener('blur', () => stopSelfTyping());

  chatAttachmentInput?.addEventListener('change', handleAttachmentSelection);
  chatReplyClear?.addEventListener('click', () => clearReplyTarget());
  chatThreadClose?.addEventListener('click', () => closeThread());
  chatSearchToggle?.addEventListener('click', () => toggleSearchPanel());
  chatSearchClose?.addEventListener('click', () => toggleSearchPanel(false));
  chatSearchForm?.addEventListener('submit', performChatSearch);

  voiceConnect?.addEventListener('click', () => {
    connectVoice();
  });

  voiceDisconnect?.addEventListener('click', () => {
    disconnectVoice();
  });

  voiceStart?.addEventListener('click', () => {
    startVoiceCall();
  });

  voiceRoleToggle?.addEventListener('click', () => {
    toggleVoiceRole();
  });

  voiceMuteToggle?.addEventListener('click', () => {
    toggleVoiceMute();
  });

  voiceDeafenToggle?.addEventListener('click', () => {
    toggleVoiceDeafen();
  });

  voiceVideoToggle?.addEventListener('click', () => {
    void toggleVoiceVideo();
  });

  voiceRecordingToggle?.addEventListener('click', () => {
    toggleVoiceRecording();
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

  cameraSelect?.addEventListener('change', async () => {
    state.voice.selectedCameraId = cameraSelect.value || null;
    if (!state.voice.enableVideo) {
      return;
    }
    if (state.voice.ws && state.voice.ws.readyState === WebSocket.OPEN) {
      try {
        await ensureLocalStream();
        sendVoiceState({ event: 'media', videoEnabled: state.voice.enableVideo });
      } catch (error) {
        setStatus(voiceStatus, error.message || 'Не удалось обновить камеру', 'error');
      }
    }
  });
}

refreshConnectionIndicators();
if (!ensureAuthenticated()) {
  // Не запускаем остальную инициализацию, если пользователя перенаправляют
  return;
}

if (roomCreateSection) {
  roomCreateSection.hidden = false;
}

loadRuntimeConfig().then(() => {
  updateVoiceControls();
});

setupEventListeners();
renderPendingAttachments();
renderSearchResults();
renderReplyPreview();
initializeRoomForm();
updatePlaceholder();
