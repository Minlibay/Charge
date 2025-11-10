import type { CustomRole } from '../../types';

interface RoleBadgeProps {
  role: CustomRole;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function RoleBadge({ role, className = '', size = 'md' }: RoleBadgeProps): JSX.Element {
  const sizeClass = size === 'sm' ? 'role-badge--sm' : size === 'lg' ? 'role-badge--lg' : '';

  const style = {
    '--role-color': role.color,
  } as React.CSSProperties;

  return (
    <span
      className={`role-badge ${sizeClass} ${className}`}
      style={style}
      title={role.name}
    >
      {role.name}
    </span>
  );
}

