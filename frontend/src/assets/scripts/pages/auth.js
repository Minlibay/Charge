import { apiFetch } from '../api.js';
import { getApiBase, setApiBase, getToken, setToken } from '../storage.js';
import { setStatus, clearStatus } from '../ui.js';

const apiForm = document.getElementById('api-form');
const apiBaseInput = document.getElementById('api-base');
const apiStatus = document.getElementById('api-status');
const redirectBanner = document.getElementById('redirect-banner');
const authStatus = document.getElementById('auth-status');
const registerForm = document.getElementById('register-form');
const registerStatus = document.getElementById('register-status');
const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');

function updateAuthIndicators() {
  const token = getToken();
  if (token) {
    setStatus(authStatus, 'Авторизовано', 'success');
    redirectBanner.hidden = false;
  } else {
    setStatus(authStatus, 'Не авторизовано');
    redirectBanner.hidden = true;
  }
}

function updateApiIndicator() {
  const base = getApiBase();
  apiBaseInput.value = base;
  setStatus(apiStatus, `API: ${base}`, 'success');
}

async function handleRegister(event) {
  event.preventDefault();
  clearStatus(registerStatus);
  const form = event.currentTarget;
  const data = new FormData(form);
  const login = data.get('login')?.toString().trim();
  const displayName = data.get('display_name')?.toString().trim();
  const password = data.get('password')?.toString();

  if (!login || !displayName || !password) {
    setStatus(registerStatus, 'Заполните все поля', 'error');
    return;
  }

  setStatus(registerStatus, 'Создание пользователя…');
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ login, display_name: displayName, password }),
    });
    setStatus(registerStatus, 'Пользователь создан. Теперь войдите.', 'success');
    const loginInput = loginForm.querySelector('input[name="login"]');
    const passwordInput = loginForm.querySelector('input[name="password"]');
    if (loginInput) loginInput.value = login;
    if (passwordInput) passwordInput.value = password;
    loginForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    setStatus(registerStatus, error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
}

async function handleLogin(event) {
  event.preventDefault();
  clearStatus(loginStatus);
  const form = event.currentTarget;
  const data = new FormData(form);
  const login = data.get('login')?.toString().trim();
  const password = data.get('password')?.toString();

  if (!login || !password) {
    setStatus(loginStatus, 'Введите логин и пароль', 'error');
    return;
  }

  setStatus(loginStatus, 'Выполняем вход…');
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const tokenResponse = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login, password }),
    });
    if (tokenResponse && tokenResponse.access_token) {
      setToken(tokenResponse.access_token);
      setStatus(loginStatus, 'Готово! Перенаправляем…', 'success');
      updateAuthIndicators();
      setTimeout(() => {
        window.location.href = './workspace.html';
      }, 400);
    } else {
      throw new Error('Не удалось получить токен');
    }
  } catch (error) {
    setStatus(loginStatus, error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
}

apiForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = apiBaseInput.value.trim();
  if (!value) {
    setStatus(apiStatus, 'Введите корректный URL', 'error');
    return;
  }
  setApiBase(value);
  updateApiIndicator();
  setStatus(apiStatus, 'URL сохранён', 'success');
});

registerForm?.addEventListener('submit', handleRegister);
loginForm?.addEventListener('submit', handleLogin);

updateApiIndicator();
updateAuthIndicators();

if (getToken()) {
  // Автоматический переход, если пользователь уже авторизован и вернулся на страницу входа
  setTimeout(() => {
    if (window.location.hash !== '#stay') {
      window.location.href = './workspace.html';
    }
  }, 800);
}
