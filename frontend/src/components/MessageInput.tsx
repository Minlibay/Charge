import { FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { autoResizeTextarea } from '../utils/format';

interface MessageInputProps {
  channelName?: string;
  onSend: (content: string) => void;
  onTyping: (isTyping: boolean) => void;
  disabled?: boolean;
}

export function MessageInput({ channelName, onSend, onTyping, disabled }: MessageInputProps): JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const typingTimeoutRef = useRef<number | undefined>();

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [value]);

  const notifyTyping = (isTyping: boolean) => {
    onTyping(isTyping);
    if (!isTyping) {
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = undefined;
      }
      return;
    }
    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = window.setTimeout(() => {
      onTyping(false);
      typingTimeoutRef.current = undefined;
    }, 3000);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    onSend(trimmed);
    setValue('');
    notifyTyping(false);
  };

  return (
    <form className="message-input" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor="chat-message">
        {t('chat.placeholder', { name: channelName ?? 'channel' })}
      </label>
      <textarea
        id="chat-message"
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          notifyTyping(true);
        }}
        onFocus={() => notifyTyping(true)}
        onBlur={() => notifyTyping(false)}
        placeholder={t('chat.placeholder', { name: channelName ?? 'channel' })}
        rows={1}
        disabled={disabled}
      />
      <button type="submit" className="primary" disabled={disabled}>
        {t('chat.send')}
      </button>
    </form>
  );
}
