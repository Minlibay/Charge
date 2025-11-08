import clsx from 'clsx';
import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Message, RoomMemberSummary } from '../types';
import { autoResizeTextarea } from '../utils/format';
import type { MessageComposerPayload } from './ChatView';
import { COMMON_EMOJIS } from '../utils/emojis';
import { logger } from '../services/logger';

interface MessageInputProps {
  channelName?: string;
  onSend: (payload: MessageComposerPayload) => Promise<void>;
  onTyping: (isTyping: boolean) => void;
  disabled?: boolean;
  members: RoomMemberSummary[];
  replyingTo?: Message | null;
  onCancelReply?: () => void;
}

interface MentionState {
  start: number;
  query: string;
}

export function MessageInput({
  channelName,
  onSend,
  onTyping,
  disabled,
  members,
  replyingTo,
  onCancelReply,
}: MessageInputProps): JSX.Element {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingTimeoutRef = useRef<number | undefined>();

  const [value, setValue] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);

  const mentionCandidates = useMemo(() => {
    if (!mentionState) {
      return [];
    }
    const query = mentionState.query.toLowerCase();
    return members
      .filter((member) => member.login.toLowerCase().startsWith(query))
      .slice(0, 8);
  }, [members, mentionState]);

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [value]);

  useEffect(() => {
    if (!mentionState || mentionCandidates.length === 0) {
      setSelectedMentionIndex(0);
      return;
    }
    if (selectedMentionIndex >= mentionCandidates.length) {
      setSelectedMentionIndex(0);
    }
  }, [mentionCandidates, mentionState, selectedMentionIndex]);

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

  const updateMentionState = (inputValue: string, cursor: number) => {
    const slice = inputValue.slice(0, cursor);
    const match = /(^|\s)@([a-zA-Z0-9_.-]{0,32})$/.exec(slice);
    if (match) {
      const startIndex = cursor - match[2].length - 1;
      setMentionState({ start: Math.max(startIndex, 0), query: match[2] });
    } else {
      setMentionState(null);
    }
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    setValue(nextValue);
    updateMentionState(nextValue, event.target.selectionStart ?? nextValue.length);
    notifyTyping(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle mention autocomplete navigation
    if (mentionState && mentionCandidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedMentionIndex((prev) => (prev + 1) % mentionCandidates.length);
        return;
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedMentionIndex((prev) => (prev - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const candidate = mentionCandidates[selectedMentionIndex];
        if (candidate) {
          insertMention(candidate.login);
        }
        return;
      } else if (event.key === 'Escape') {
        setMentionState(null);
        return;
      }
    }

    // Handle Enter key for sending message
    // Enter = send, Shift+Enter = new line
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!disableSend && !submitting) {
        // Create a minimal synthetic form event for handleSubmit
        const form = textareaRef.current?.closest('form');
        if (form) {
          const syntheticEvent = {
            preventDefault: () => {},
            target: form,
            currentTarget: form,
          } as FormEvent<HTMLFormElement>;
          void handleSubmit(syntheticEvent);
        }
      }
    }
  };

  const insertMention = (login: string) => {
    if (!textareaRef.current || !mentionState) {
      return;
    }
    const before = value.slice(0, mentionState.start);
    const after = value.slice(textareaRef.current.selectionStart ?? value.length);
    const mentionText = `@${login} `;
    const nextValue = `${before}${mentionText}${after}`;
    setValue(nextValue);
    setMentionState(null);
    const cursor = before.length + mentionText.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const handleSelectMention = (login: string) => {
    insertMention(login);
  };

  const handleToggleEmoji = () => {
    setEmojiOpen((open) => !open);
  };

  const handleInsertEmoji = (symbol: string) => {
    if (!textareaRef.current) {
      setValue((prev) => `${prev}${symbol}`);
      return;
    }
    const start = textareaRef.current.selectionStart ?? value.length;
    const end = textareaRef.current.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const nextValue = `${before}${symbol}${after}`;
    setValue(nextValue);
    const cursor = start + symbol.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files ? Array.from(event.target.files) : [];
    if (selected.length > 0) {
      setFiles((prev) => [...prev, ...selected]);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeFile = (file: File) => {
    setFiles((prev) => prev.filter((item) => item !== file));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed && files.length === 0) {
      return;
    }
    setSubmitting(true);
    try {
      await onSend({
        content: value,
        files: files.length > 0 ? files : undefined,
        parentId: replyingTo ? replyingTo.id : null,
      });
      setValue('');
      setFiles([]);
      setMentionState(null);
      setSelectedMentionIndex(0);
      if (onCancelReply) {
        onCancelReply();
      }
      setEmojiOpen(false);
    } catch (error) {
      // Keep content so the user can retry
      logger.warn('Failed to send message', undefined, error instanceof Error ? error : new Error(String(error)));
    } finally {
      setSubmitting(false);
      notifyTyping(false);
    }
  };

  const disableSend = disabled || submitting || (value.trim() === '' && files.length === 0);

  return (
    <form className="message-input" onSubmit={handleSubmit}>
      {replyingTo && (
        <div className="message-input__replying">
          <div>
            <span className="message-input__replying-label">{t('chat.replyingTo', { defaultValue: 'Ответ на' })}</span>
            <span className="message-input__replying-author">{replyingTo.author?.display_name ?? replyingTo.author?.login ?? t('chat.unknownUser', { defaultValue: 'пользователя' })}</span>
            <span className="message-input__replying-snippet">{replyingTo.content}</span>
          </div>
          {onCancelReply && (
            <button type="button" className="ghost" onClick={onCancelReply}>
              {t('chat.cancel', { defaultValue: 'Отмена' })}
            </button>
          )}
        </div>
      )}
      <div className="message-input__controls">
        <button
          type="button"
          className="ghost"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || submitting}
          aria-label={t('chat.attachFile', { defaultValue: 'Прикрепить файл' })}
        >
          📎
        </button>
        <button
          type="button"
          className="ghost"
          onClick={handleToggleEmoji}
          disabled={disabled || submitting}
          aria-label={t('chat.emojiPicker', { defaultValue: 'Выбрать эмодзи' })}
        >
          😀
        </button>
        {emojiOpen && !disabled && (
          <div className="message-input__emoji-picker">
            <div className="message-input__emoji-grid">
              {COMMON_EMOJIS.map((emoji) => (
                <button
                  type="button"
                  key={emoji}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    handleInsertEmoji(emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="sr-only" htmlFor="chat-message">
          {t('chat.placeholder', { name: channelName ?? 'channel' })}
        </label>
        <textarea
          id="chat-message"
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => notifyTyping(true)}
          onBlur={() => notifyTyping(false)}
          placeholder={t('chat.placeholder', { name: channelName ?? 'channel' })}
          rows={1}
          disabled={disabled}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={handleFileChange}
          aria-hidden="true"
        />
        <button type="submit" className="primary" disabled={disableSend}>
          {submitting ? t('common.loading') : t('chat.send')}
        </button>
      </div>
      {files.length > 0 && (
        <div className="message-input__attachments">
          {files.map((file) => {
            const isImage = file.type.startsWith('image/');
            const fileSize = file.size < 1024
              ? `${file.size} B`
              : file.size < 1024 * 1024
                ? `${(file.size / 1024).toFixed(1)} KB`
                : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
            const objectUrl = isImage ? URL.createObjectURL(file) : null;

            return (
              <div key={`${file.name}-${file.size}`} className="message-input__attachment">
                {isImage && objectUrl ? (
                  <div className="message-input__attachment-preview">
                    <img src={objectUrl} alt={file.name} />
                    <div className="message-input__attachment-overlay">
                      <span className="message-input__attachment-name">{file.name}</span>
                      <span className="message-input__attachment-size">{fileSize}</span>
                    </div>
                  </div>
                ) : (
                  <div className="message-input__attachment-info">
                    <span className="message-input__attachment-icon" aria-hidden="true">📎</span>
                    <div className="message-input__attachment-details">
                      <span className="message-input__attachment-name">{file.name}</span>
                      <span className="message-input__attachment-size">{fileSize}</span>
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  className="message-input__attachment-remove ghost"
                  onClick={() => {
                    if (objectUrl) {
                      URL.revokeObjectURL(objectUrl);
                    }
                    removeFile(file);
                  }}
                  disabled={submitting}
                  aria-label={t('chat.removeAttachment', { defaultValue: 'Удалить вложение' })}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      {mentionState && mentionCandidates.length > 0 && (
        <ul className="message-input__mentions" role="listbox">
          {mentionCandidates.map((candidate, index) => (
            <li
              key={candidate.user_id}
              className={clsx('message-input__mention', { 'message-input__mention--active': index === selectedMentionIndex })}
            >
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  handleSelectMention(candidate.login);
                }}
              >
                @{candidate.login}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
