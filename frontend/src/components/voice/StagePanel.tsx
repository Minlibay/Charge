import clsx from 'clsx';
import { useMemo } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ScreenShareQuality,
  VoiceParticipant,
  VoiceRoomStats,
} from '../../types';
import { QualityIndicator } from './QualityIndicator';

interface StagePanelProps {
  participants: VoiceParticipant[];
  localParticipantId: number | null;
  stats: VoiceRoomStats | null;
  screenShareQuality: ScreenShareQuality;
  onScreenShareQualityChange: (quality: ScreenShareQuality) => void;
  onToggleHand: (raised: boolean) => void;
}

const STATUS_LABELS: Record<string, string> = {
  live: 'On stage',
  muted: 'Muted',
  backstage: 'Backstage',
  invited: 'Invited',
  requesting: 'Requesting',
  listener: 'Listener',
};

const QUALITY_OPTIONS: ScreenShareQuality[] = ['low', 'medium', 'high'];

export function StagePanel({
  participants,
  localParticipantId,
  stats,
  screenShareQuality,
  onScreenShareQualityChange,
  onToggleHand,
}: StagePanelProps): JSX.Element {
  const { t } = useTranslation();

  const speakers = useMemo(
    () => participants.filter((participant) => participant.role === 'speaker'),
    [participants],
  );
  const listeners = useMemo(
    () => participants.filter((participant) => participant.role !== 'speaker'),
    [participants],
  );

  const localParticipant = useMemo(
    () => participants.find((participant) => participant.id === localParticipantId) ?? null,
    [participants, localParticipantId],
  );
  const localRaised = Boolean(localParticipant?.handRaised);
  const canRaiseHand = Boolean(localParticipant && localParticipant.role !== 'speaker');

  const handleQualityChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onScreenShareQualityChange(event.target.value as ScreenShareQuality);
  };

  const statsSummary = stats
    ? t('voice.stage.stats', {
        defaultValue: '{{speakers}} speakers · {{listeners}} listeners',
        speakers: stats.speakers,
        listeners: stats.listeners,
      })
    : null;

  return (
    <section className="stage-panel" aria-labelledby="stage-panel-title">
      <header className="stage-panel__header">
        <div>
          <h3 id="stage-panel-title">{t('voice.stage.title', { defaultValue: 'Stage' })}</h3>
          {statsSummary ? <p className="stage-panel__summary">{statsSummary}</p> : null}
        </div>
        <div className="stage-panel__controls" role="group" aria-label={t('voice.stage.controls', { defaultValue: 'Stage controls' })}>
          <label className="stage-panel__quality">
            <span>{t('voice.stage.screenShareQuality', { defaultValue: 'Screen share quality' })}</span>
            <select value={screenShareQuality} onChange={handleQualityChange}>
              {QUALITY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {t(`voice.stage.quality.${option}`, {
                    defaultValue:
                      option === 'low'
                        ? 'Low'
                        : option === 'medium'
                          ? 'Medium'
                          : 'High',
                  })}
                </option>
              ))}
            </select>
          </label>
          {canRaiseHand ? (
            <button
              type="button"
              className={clsx('stage-panel__hand', { 'stage-panel__hand--active': localRaised })}
              onClick={() => onToggleHand(!localRaised)}
            >
              {localRaised
                ? t('voice.stage.lowerHand', { defaultValue: 'Lower hand' })
                : t('voice.stage.raiseHand', { defaultValue: 'Raise hand' })}
            </button>
          ) : null}
        </div>
      </header>

      <div className="stage-panel__body">
        <section className="stage-panel__section" aria-labelledby="stage-speakers-title">
          <h4 id="stage-speakers-title">{t('voice.stage.speakers', { defaultValue: 'Speakers' })}</h4>
          {speakers.length === 0 ? (
            <p className="panel-empty">{t('voice.stage.noSpeakers', { defaultValue: 'No speakers yet' })}</p>
          ) : (
            <ul className="stage-panel__list">
              {speakers.map((speaker) => {
                const statusKey = speaker.stageStatus ?? 'live';
                const statusLabel = t(`voice.stage.status.${statusKey}`, {
                  defaultValue: STATUS_LABELS[statusKey] ?? statusKey,
                });
                const isLocal = speaker.id === localParticipantId;
                const quality = speaker.quality?.audio ?? speaker.quality?.screen ?? null;
                return (
                  <li key={speaker.id} className={clsx('stage-panel__item', { 'stage-panel__item--local': isLocal })}>
                    <div className="stage-panel__item-header">
                      <span className="stage-panel__name">{speaker.displayName}</span>
                      <span className={clsx('stage-panel__status', `stage-panel__status--${statusKey}`)}>{statusLabel}</span>
                    </div>
                    <QualityIndicator metrics={quality} label={speaker.displayName} track="audio" />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="stage-panel__section" aria-labelledby="stage-listeners-title">
          <h4 id="stage-listeners-title">{t('voice.stage.listeners', { defaultValue: 'Listeners' })}</h4>
          {listeners.length === 0 ? (
            <p className="panel-empty">{t('voice.stage.noListeners', { defaultValue: 'No listeners yet' })}</p>
          ) : (
            <ul className="stage-panel__list stage-panel__list--compact">
              {listeners.map((listener) => (
                <li key={listener.id} className={clsx('stage-panel__item', { 'stage-panel__item--raised': listener.handRaised })}>
                  <span className="stage-panel__name">{listener.displayName}</span>
                  {listener.handRaised ? (
                    <span className="stage-panel__raised" aria-label={t('voice.stage.raisedHand', { defaultValue: 'Raised hand' })}>
                      ✋
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
