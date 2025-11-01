import type { PresenceStatus } from '../../types';

interface PresenceIndicatorProps {
  status: PresenceStatus;
  label: string;
}

export function PresenceIndicator({ status, label }: PresenceIndicatorProps): JSX.Element {
  return (
    <span className={`presence presence-${status}`} aria-label={label} title={label}>
      <span className="presence-indicator" aria-hidden />
    </span>
  );
}
