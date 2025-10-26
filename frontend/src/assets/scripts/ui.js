function setStatus(element, message, type = '') {
  if (!element) return;
  element.textContent = message;
  element.hidden = false;
  element.classList.remove('error', 'success');
  if (type) {
    element.classList.add(type);
  }
}

function clearStatus(element) {
  if (!element) return;
  element.hidden = true;
  element.textContent = '';
  element.classList.remove('error', 'success');
}

function formatDate(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

function autoResizeTextarea(textarea) {
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

export { setStatus, clearStatus, formatDate, autoResizeTextarea };
