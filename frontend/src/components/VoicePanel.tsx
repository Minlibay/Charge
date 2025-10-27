import { useTranslation } from 'react-i18next';

import type { Channel, VoiceParticipant } from '../types';

interface VoicePanelProps {
  channels: Channel[];
  participants: VoiceParticipant[];
}

export function VoicePanel({ channels, participants }: VoicePanelProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="voice-panel" aria-labelledby="voice-title">
      <header className="panel-header">
        <h2 id="voice-title">{t('voice.title')}</h2>
      </header>
      <div className="voice-section">
        {channels.length === 0 ? (
          <p className="panel-empty">{t('voice.connectHint')}</p>
        ) : (
          <ul className="voice-channel-list">
            {channels.map((channel) => (
              <li key={channel.id}>
                <div className="voice-channel">
                  <span className="voice-channel__name">{channel.name}</span>
                  <button type="button" className="ghost" disabled>
                    {t('voice.join')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="voice-participants">
        <h3>{t('voice.participants', { defaultValue: 'Participants' })}</h3>
        {participants.length === 0 ? (
          <p className="panel-empty">{t('voice.empty')}</p>
        ) : (
          <ul>
            {participants.map((participant) => (
              <li key={participant.id}>
                <span className="presence-avatar" aria-hidden="true">
                  {participant.displayName.charAt(0).toUpperCase()}
                </span>
                <div className="voice-participant__details">
                  <span className="presence-name">{participant.displayName}</span>
                  <span className="voice-participant__role">{participant.role}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
