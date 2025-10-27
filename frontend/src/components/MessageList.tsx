import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Message } from '../types';
import { formatDateTime } from '../utils/format';

interface MessageListProps {
  messages: Message[];
}

export function MessageList({ messages }: MessageListProps): JSX.Element {
  const { i18n } = useTranslation();

  const rendered = useMemo(
    () =>
      messages.map((message) => {
        const authorLabel = message.author_id ? `User #${message.author_id}` : 'System';
        const timestamp = formatDateTime(message.created_at, i18n.language);
        return (
          <article className="message" key={message.id} aria-label={authorLabel} tabIndex={0}>
            <header className="message__meta">
              <span className="message__author">{authorLabel}</span>
              <time dateTime={message.created_at}>{timestamp}</time>
            </header>
            <p className="message__content">{message.content}</p>
            {message.attachments.length > 0 && (
              <ul className="message__attachments">
                {message.attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <a href={attachment.download_url} target="_blank" rel="noreferrer">
                      {attachment.file_name}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {message.reactions.length > 0 && (
              <ul className="message__reactions" aria-label="Reactions">
                {message.reactions.map((reaction) => (
                  <li key={reaction.emoji}>
                    <span>{reaction.emoji}</span>
                    <span className="message__reaction-count">{reaction.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        );
      }),
    [i18n.language, messages],
  );

  return <div className="message-list">{rendered}</div>;
}
