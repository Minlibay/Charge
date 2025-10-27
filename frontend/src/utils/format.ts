export function formatDateTime(
  value: string | number | Date,
  locale: string = typeof navigator !== 'undefined' ? navigator.language : 'en-US',
): string {
  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
    });
    return formatter.format(typeof value === 'string' ? new Date(value) : value);
  } catch (error) {
    return new Date(value).toLocaleString();
  }
}

export function autoResizeTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) {
    return;
  }
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}
