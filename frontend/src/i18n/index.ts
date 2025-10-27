import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const resources = {
  en: {
    translation: {
      app: {
        title: 'Charge Workspace',
        openSettings: 'Open settings',
        signInRequired: 'Sign in to access your rooms',
        reconnect: 'Reconnect',
        tokenReady: 'Token loaded',
        tokenMissing: 'Token missing',
      },
      servers: {
        title: 'Servers',
        empty: 'You are not a member of any rooms yet.',
        create: 'Create room',
      },
      channels: {
        title: 'Channels',
        text: 'Text Channels',
        voice: 'Voice Channels',
        empty: 'No channels yet',
        loading: 'Loading channels…',
      },
      chat: {
        title: 'Chat',
        placeholder: 'Message #{{name}}',
        send: 'Send',
        empty: 'No messages yet — start the conversation!',
        typing: '{{users}} is typing…',
        typingMany: '{{count}} people are typing…',
        connection: {
          connecting: 'Connecting…',
          error: 'Connection lost',
          connected: 'Connected',
        },
      },
      presence: {
        title: 'Online',
        empty: 'Nobody is here yet.',
      },
      voice: {
        title: 'Voice',
        connectHint: 'Select a voice channel to preview participants.',
        empty: 'Nobody in voice channels yet.',
        join: 'Connect',
        leave: 'Disconnect',
        participants: 'Participants',
      },
      settings: {
        title: 'Workspace settings',
        apiBase: 'API base URL',
        token: 'Access token',
        tokenHint: 'Tokens are stored only in this browser.',
        save: 'Save',
        reset: 'Clear',
        close: 'Close',
        theme: 'Theme',
        language: 'Language',
      },
      theme: {
        light: 'Light',
        dark: 'Dark',
      },
      language: {
        ru: 'Русский',
        en: 'English',
      },
      errors: {
        missingToken: 'Add an access token to continue.',
        loadRooms: 'Failed to load rooms',
        loadRoom: 'Failed to load room',
      },
      common: {
        loading: 'Loading…',
        retry: 'Retry',
      },
    },
  },
  ru: {
    translation: {
      app: {
        title: 'Рабочая область Charge',
        openSettings: 'Открыть настройки',
        signInRequired: 'Авторизуйтесь, чтобы увидеть комнаты',
        reconnect: 'Переподключиться',
        tokenReady: 'Токен загружен',
        tokenMissing: 'Нет токена',
      },
      servers: {
        title: 'Серверы',
        empty: 'Вы ещё не присоединились ни к одной комнате.',
        create: 'Создать комнату',
      },
      channels: {
        title: 'Каналы',
        text: 'Текстовые каналы',
        voice: 'Голосовые каналы',
        empty: 'Каналы пока не созданы',
        loading: 'Загружаем каналы…',
      },
      chat: {
        title: 'Чат',
        placeholder: 'Сообщение в #{{name}}',
        send: 'Отправить',
        empty: 'Сообщений ещё нет — начните диалог!',
        typing: '{{users}} печатает…',
        typingMany: '{{count}} участника печатают…',
        connection: {
          connecting: 'Подключаемся…',
          error: 'Соединение потеряно',
          connected: 'Подключено',
        },
      },
      presence: {
        title: 'Онлайн',
        empty: 'В канале пока никого нет.',
      },
      voice: {
        title: 'Голос',
        connectHint: 'Выберите голосовой канал, чтобы увидеть участников.',
        empty: 'Никто не в голосовых комнатах.',
        join: 'Подключиться',
        leave: 'Отключиться',
        participants: 'Участники',
      },
      settings: {
        title: 'Настройки рабочей области',
        apiBase: 'Базовый URL API',
        token: 'Токен доступа',
        tokenHint: 'Токены хранятся только в этом браузере.',
        save: 'Сохранить',
        reset: 'Очистить',
        close: 'Закрыть',
        theme: 'Тема',
        language: 'Язык',
      },
      theme: {
        light: 'Светлая',
        dark: 'Тёмная',
      },
      language: {
        ru: 'Русский',
        en: 'English',
      },
      errors: {
        missingToken: 'Добавьте токен доступа, чтобы продолжить.',
        loadRooms: 'Не удалось загрузить список комнат',
        loadRoom: 'Не удалось загрузить комнату',
      },
      common: {
        loading: 'Загрузка…',
        retry: 'Повторить',
      },
    },
  },
} as const;

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng:
      typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('ru')
        ? 'ru'
        : 'en',
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  })
  .catch((error) => {
    console.error('Failed to initialize i18n', error);
  });

export default i18n;
