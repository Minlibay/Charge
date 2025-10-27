import { FormEvent, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../../state/workspaceStore';
import type { RoomRoleLevel } from '../../types';

interface RoleManagerDialogProps {
  open: boolean;
  roomSlug: string | null;
  hierarchy: RoomRoleLevel[];
  onClose: () => void;
}

export function RoleManagerDialog({ open, roomSlug, hierarchy, onClose }: RoleManagerDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const updateRoleLevel = useWorkspaceStore((state) => state.updateRoleLevel);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const map: Record<string, number> = {};
      for (const entry of hierarchy) {
        map[entry.role] = entry.level;
      }
      setLevels(map);
      setError(null);
      setPendingRole(null);
    }
  }, [hierarchy, open]);

  if (!open || !roomSlug || typeof document === 'undefined') {
    return null;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>, role: string) => {
    event.preventDefault();
    const level = levels[role];
    if (!Number.isFinite(level)) {
      setError(t('roles.levelRequired'));
      return;
    }
    setPendingRole(role);
    setError(null);
    try {
      await updateRoleLevel(roomSlug, role as RoomRoleLevel['role'], level);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(t('roles.updateFailed'));
      }
    } finally {
      setPendingRole(null);
    }
  };

  return createPortal(
    <div className="modal-overlay" role="presentation">
      <div className="server-modal" role="dialog" aria-modal="true" aria-labelledby="role-manager-title">
        <header className="modal-header">
          <div>
            <h2 id="role-manager-title">{t('roles.manageTitle')}</h2>
            <p className="modal-description">{t('roles.manageSubtitle')}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label={t('common.close')}>
            {t('common.close')}
          </button>
        </header>
        {error && <p className="auth-form__error" role="alert">{error}</p>}
        <div className="modal-body">
          <table className="role-table">
            <thead>
              <tr>
                <th>{t('roles.role')}</th>
                <th>{t('roles.level')}</th>
                <th aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {hierarchy.map((entry) => (
                <tr key={entry.role}>
                  <td>{t(`roles.${entry.role}`)}</td>
                  <td>
                    <form className="role-form" onSubmit={(event) => handleSubmit(event, entry.role)}>
                      <input
                        type="number"
                        min={0}
                        value={levels[entry.role] ?? entry.level}
                        onChange={(event) =>
                          setLevels((prev) => ({ ...prev, [entry.role]: Number(event.target.value) }))
                        }
                      />
                      <button type="submit" className="ghost" disabled={pendingRole === entry.role}>
                        {pendingRole === entry.role ? t('common.loading') : t('roles.save')}
                      </button>
                    </form>
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>,
    document.body,
  );
}
