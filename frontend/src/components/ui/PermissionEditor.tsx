import { useTranslation } from 'react-i18next';
import { ROOM_PERMISSIONS, type RoomPermission } from '../../types';

interface PermissionEditorProps {
  permissions: Set<RoomPermission>;
  onChange: (permissions: Set<RoomPermission>) => void;
}

export function PermissionEditor({ permissions, onChange }: PermissionEditorProps): JSX.Element {
  const { t } = useTranslation();

  const togglePermission = (permission: RoomPermission) => {
    const next = new Set(permissions);
    if (next.has(permission)) {
      next.delete(permission);
    } else {
      next.add(permission);
    }
    onChange(next);
  };

  const permissionLabels: Record<RoomPermission, string> = {
    manage_roles: t('permissions.manageRoles', { defaultValue: 'Управление ролями' }),
    manage_room: t('permissions.manageRoom', { defaultValue: 'Управление комнатой' }),
    kick_members: t('permissions.kickMembers', { defaultValue: 'Исключать участников' }),
    ban_members: t('permissions.banMembers', { defaultValue: 'Банить участников' }),
    manage_invites: t('permissions.manageInvites', { defaultValue: 'Управление приглашениями' }),
    view_audit_log: t('permissions.viewAuditLog', { defaultValue: 'Просмотр журнала аудита' }),
  };

  return (
    <div className="permission-editor">
      <label className="permission-editor__label">
        {t('roles.permissions', { defaultValue: 'Права' })}
      </label>
      <div className="permission-editor__list">
        {ROOM_PERMISSIONS.map((permission) => (
          <label
            key={permission}
            className="permission-editor__item"
          >
            <input
              type="checkbox"
              className="permission-editor__checkbox"
              checked={permissions.has(permission)}
              onChange={() => togglePermission(permission)}
            />
            <span className="permission-editor__label-text">
              {permissionLabels[permission]}
            </span>
          </label>
        ))}
      </div>
      {permissions.size === 0 && (
        <p className="permission-editor__hint">
          {t('roles.noPermissionsHint', { defaultValue: 'Роль без прав будет иметь только базовые разрешения' })}
        </p>
      )}
    </div>
  );
}

