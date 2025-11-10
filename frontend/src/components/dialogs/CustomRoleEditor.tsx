import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { CustomRole, CustomRoleCreate, RoomPermission } from '../../types';
import { XIcon } from '../icons/LucideIcons';
import { RoleColorPicker, PermissionEditor } from '../ui';

interface CustomRoleEditorProps {
  open: boolean;
  roomSlug: string | null;
  role?: CustomRole;
  onClose: () => void;
  onSave: (roleData: Partial<CustomRoleCreate>) => Promise<void>;
}

export function CustomRoleEditor({
  open,
  roomSlug,
  role,
  onClose,
  onSave,
}: CustomRoleEditorProps): JSX.Element | null {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#99AAB5');
  const [hoist, setHoist] = useState(false);
  const [mentionable, setMentionable] = useState(false);
  const [permissions, setPermissions] = useState<Set<RoomPermission>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      if (role) {
        setName(role.name);
        setColor(role.color);
        setHoist(role.hoist);
        setMentionable(role.mentionable);
        setPermissions(new Set(role.permissions));
      } else {
        setName('');
        setColor('#99AAB5');
        setHoist(false);
        setMentionable(false);
        setPermissions(new Set());
      }
      setError(null);
    }
  }, [open, role]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t('roles.nameRequired', { defaultValue: 'Название роли обязательно' }));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        color,
        hoist,
        mentionable,
        permissions: Array.from(permissions),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('roles.saveFailed'));
    } finally {
      setSaving(false);
    }
  };


  if (!open || !roomSlug || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="server-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '600px', width: '90%' }}
      >
        <header className="modal-header">
          <div>
            <h2>{role ? t('roles.editRole', { defaultValue: 'Редактировать роль' }) : t('roles.createRole', { defaultValue: 'Создать роль' })}</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label={t('common.close')}>
            <XIcon size={20} />
          </button>
        </header>
        {error && (
          <p className="auth-form__error" role="alert">
            {error}
          </p>
        )}
        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div>
              <label htmlFor="role-name" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                {t('roles.roleName', { defaultValue: 'Название роли' })}
              </label>
              <input
                id="role-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={128}
                required
                style={{ width: '100%', padding: '0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color, #e0e0e0)' }}
              />
            </div>

            <RoleColorPicker value={color} onChange={setColor} />

            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={hoist} onChange={(e) => setHoist(e.target.checked)} />
                <span>{t('roles.hoist', { defaultValue: 'Показывать участников с этой ролью отдельной группой' })}</span>
              </label>
            </div>

            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={mentionable} onChange={(e) => setMentionable(e.target.checked)} />
                <span>{t('roles.mentionable', { defaultValue: 'Роль можно упоминать' })}</span>
              </label>
            </div>

            <PermissionEditor permissions={permissions} onChange={setPermissions} />
          </div>
          <footer style={{ padding: '1rem', borderTop: '1px solid var(--border-color, #e0e0e0)', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
            <button type="button" className="ghost" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="primary" disabled={saving || !name.trim()}>
              {saving ? t('common.loading') : t('common.save')}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}

