import type { CustomRole } from '../../types';

interface RoleBadgeProps {
  role: CustomRole;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function RoleBadge({ role, className = '', size = 'md' }: RoleBadgeProps): JSX.Element {
  const sizeClasses = {
    sm: 'text-xs px-1.5 py-0.5',
    md: 'text-sm px-2 py-1',
    lg: 'text-base px-2.5 py-1.5',
  };

  const style = {
    backgroundColor: `${role.color}20`, // 20% opacity
    color: role.color,
    borderColor: `${role.color}40`, // 40% opacity
  };

  return (
    <span
      className={`inline-flex items-center rounded border font-medium ${sizeClasses[size]} ${className}`}
      style={style}
      title={role.name}
    >
      {role.name}
    </span>
  );
}

