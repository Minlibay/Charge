import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import type { CustomRole, CustomRoleCreate, RoomPermission } from '../../types';
import { ROOM_PERMISSIONS } from '../../types';

interface CustomRoleEditorProps {
  open: boolean;
  roomSlug: string | null;
  role?: CustomRole;
  onClose: () => void;
  onSave: (roleData: Partial<CustomRoleCreate>) => Promise<void>;
}

const DEFAULT_COLORS = [
  '#FF5733', '#33FF57', '#3357FF', '#FF33F5', '#F5FF33',
  '#33FFF5', '#FF8C33', '#8C33FF', '#33FF8C', '#FF338C',
  '#99AAB5', '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
];

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

  const togglePermission = (permission: RoomPermission) => {
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) {
        next.delete(permission);
      } else {
        next.add(permission);
      }
      return next;
    });
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
            <X size={20} />
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

            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                {t('roles.color', { defaultValue: 'Цвет' })}
              </label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                {DEFAULT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      backgroundColor: c,
                      border: color === c ? '3px solid var(--primary, #007bff)' : '2px solid transparent',
                      cursor: 'pointer',
                    }}
                    aria-label={c}
                  />
                ))}
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value.toUpperCase())}
                  style={{ width: '48px', height: '32px', border: 'none', cursor: 'pointer' }}
                />
                <input
                  type="text"
                  value={color}
                  onChange={(e) => {
                    const val = e.target.value.toUpperCase();
                    if (/^#[0-9A-F]{0,6}$/.test(val)) {
                      setColor(val);
                    }
                  }}
                  pattern="^#[0-9A-F]{6}$"
                  style={{ width: '80px', padding: '0.25rem', borderRadius: '0.25rem', border: '1px solid var(--border-color, #e0e0e0)' }}
                />
              </div>
            </div>

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

            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                {t('roles.permissions', { defaultValue: 'Права' })}
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {ROOM_PERMISSIONS.map((perm) => (
                  <label key={perm} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={permissions.has(perm)}
                      onChange={() => togglePermission(perm)}
                    />
                    <span>{t(`roles.permission.${perm}`, { defaultValue: perm })}</span>
                  </label>
                ))}
              </div>
            </div>
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

