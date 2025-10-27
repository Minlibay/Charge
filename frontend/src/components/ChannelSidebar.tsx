import clsx from 'clsx';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, ChannelCategory, RoomRole } from '../types';

interface ChannelSidebarProps {
  channels: Channel[];
  categories: ChannelCategory[];
  selectedChannelId: number | null;
  onSelectChannel: (channelId: number) => void;
  roomTitle?: string;
  currentRole?: RoomRole | null;
}

export function ChannelSidebar({
  channels,
  categories,
  selectedChannelId,
  onSelectChannel,
  roomTitle,
  currentRole,
}: ChannelSidebarProps): JSX.Element {
  const { t } = useTranslation();

  const { grouped, ungroupedText, ungroupedVoice } = useMemo(() => {
    const groupedChannels = categories.map((category) => ({
      category,
      text: channels.filter((channel) => channel.category_id === category.id && channel.type === 'text'),
      voice: channels.filter((channel) => channel.category_id === category.id && channel.type === 'voice'),
    }));
    const ungrouped = channels.filter((channel) => channel.category_id === null);
    return {
      grouped: groupedChannels,
      ungroupedText: ungrouped.filter((channel) => channel.type === 'text'),
      ungroupedVoice: ungrouped.filter((channel) => channel.type === 'voice'),
    };
  }, [categories, channels]);

  const renderChannel = (channel: Channel) => {
    const isActive = channel.id === selectedChannelId;
    return (
      <button
        key={channel.id}
        type="button"
        className={clsx('channel-item', { 'channel-item--active': isActive })}
        onClick={() => onSelectChannel(channel.id)}
        aria-current={isActive ? 'true' : undefined}
      >
        <span className="channel-item__icon" aria-hidden="true">
          {channel.type === 'voice' ? '🔊' : '#'}
        </span>
        <span className="channel-item__label">{channel.name}</span>
        <span className="channel-item__letter" aria-hidden="true">
          {channel.letter}
        </span>
      </button>
    );
  };

  return (
    <nav className="channel-sidebar" aria-label={t('channels.title')}>
      <header className="channel-sidebar__header">
        <div>
          <h2 className="channel-sidebar__title">{roomTitle ?? t('channels.title')}</h2>
          {currentRole ? (
            <span className="channel-role">{currentRole.toUpperCase()}</span>
          ) : null}
        </div>
      </header>
      <div className="channel-groups">
        {ungroupedText.length > 0 && (
          <section>
            <h3>{t('channels.text')}</h3>
            <div className="channel-list">{ungroupedText.map(renderChannel)}</div>
          </section>
        )}
        {ungroupedVoice.length > 0 && (
          <section>
            <h3>{t('channels.voice')}</h3>
            <div className="channel-list">{ungroupedVoice.map(renderChannel)}</div>
          </section>
        )}
        {grouped.map(({ category, text, voice }) => (
          <section key={category.id} className="channel-category">
            <h3>{category.name}</h3>
            <div className="channel-list">
              {text.map(renderChannel)}
              {voice.map(renderChannel)}
            </div>
          </section>
        ))}
        {channels.length === 0 && (
          <p className="sidebar-empty">{t('channels.empty')}</p>
        )}
      </div>
    </nav>
  );
}
