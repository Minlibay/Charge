const storageKeys = {
  apiBase: 'charge.apiBase',
  token: 'charge.token',
  room: 'charge.lastRoom',
};

function getApiBase() {
  return localStorage.getItem(storageKeys.apiBase) || 'http://localhost:8000';
}

function setApiBase(url) {
  if (url) {
    localStorage.setItem(storageKeys.apiBase, url);
  } else {
    localStorage.removeItem(storageKeys.apiBase);
  }
}

function getToken() {
  return localStorage.getItem(storageKeys.token);
}

function setToken(token) {
  if (token) {
    localStorage.setItem(storageKeys.token, token);
  } else {
    localStorage.removeItem(storageKeys.token);
  }
}

function getLastRoom() {
  const slug = localStorage.getItem(storageKeys.room);
  return slug || null;
}

function setLastRoom(slug) {
  if (slug) {
    localStorage.setItem(storageKeys.room, slug);
  } else {
    localStorage.removeItem(storageKeys.room);
  }
}

export { storageKeys, getApiBase, setApiBase, getToken, setToken, getLastRoom, setLastRoom };
