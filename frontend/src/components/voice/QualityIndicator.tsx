import clsx from 'clsx';

import type { VoiceQualityMetrics } from '../../types';

interface QualityIndicatorProps {
  metrics?: VoiceQualityMetrics | null;
  track?: string;
  label?: string;
}

function determineLevel(metrics?: VoiceQualityMetrics | null): { level: number; hint: string } {
  if (!metrics) {
    return { level: 0, hint: 'No data' };
  }
  const mos = typeof metrics.mos === 'number' ? metrics.mos : typeof metrics.score === 'number' ? metrics.score : null;
  if (mos !== null) {
    if (mos >= 4.2) return { level: 4, hint: `MOS ${mos.toFixed(1)}` };
    if (mos >= 3.6) return { level: 3, hint: `MOS ${mos.toFixed(1)}` };
    if (mos >= 3.0) return { level: 2, hint: `MOS ${mos.toFixed(1)}` };
    if (mos >= 2.4) return { level: 1, hint: `MOS ${mos.toFixed(1)}` };
    return { level: 0, hint: `MOS ${mos.toFixed(1)}` };
  }

  const packetLoss = typeof metrics.packetLoss === 'number' ? metrics.packetLoss : undefined;
  if (typeof packetLoss === 'number') {
    if (packetLoss < 1) return { level: 4, hint: `Loss ${packetLoss.toFixed(1)}%` };
    if (packetLoss < 2.5) return { level: 3, hint: `Loss ${packetLoss.toFixed(1)}%` };
    if (packetLoss < 5) return { level: 2, hint: `Loss ${packetLoss.toFixed(1)}%` };
    if (packetLoss < 8) return { level: 1, hint: `Loss ${packetLoss.toFixed(1)}%` };
    return { level: 0, hint: `Loss ${packetLoss.toFixed(1)}%` };
  }

  const bitrate = typeof metrics.bitrate === 'number' ? metrics.bitrate : undefined;
  if (typeof bitrate === 'number') {
    if (bitrate >= 2_500_000) return { level: 4, hint: `${Math.round(bitrate / 1000)} kbps` };
    if (bitrate >= 1_500_000) return { level: 3, hint: `${Math.round(bitrate / 1000)} kbps` };
    if (bitrate >= 750_000) return { level: 2, hint: `${Math.round(bitrate / 1000)} kbps` };
    if (bitrate >= 250_000) return { level: 1, hint: `${Math.round(bitrate / 1000)} kbps` };
    return { level: 0, hint: `${Math.round(bitrate / 1000)} kbps` };
  }

  return { level: 0, hint: 'Unknown quality' };
}

export function QualityIndicator({ metrics, track, label }: QualityIndicatorProps): JSX.Element {
  const { level, hint } = determineLevel(metrics);
  const titleParts = [label, track, hint].filter(Boolean);
  const title = titleParts.join(' · ');

  return (
    <span className={clsx('quality-indicator', `quality-indicator--level-${level}`)} title={title}>
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          className={clsx('quality-indicator__bar', {
            'quality-indicator__bar--active': index < level,
          })}
          aria-hidden="true"
        />
      ))}
      <span className="sr-only">{title || 'Connection quality'}</span>
    </span>
  );
}
