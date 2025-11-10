import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../../state/workspaceStore';
import { PlusIcon, PencilIcon, TrashIcon, GripVerticalIcon } from '../icons/LucideIcons';
import { fetchCustomRoles as apiFetchCustomRoles } from '../../services/api';
import type { CustomRole, CustomRoleWithMemberCount, CustomRoleReorderEntry } from '../../types';
import { RoleBadge } from '../ui/RoleBadge';
import { CustomRoleEditor } from './CustomRoleEditor';
import { DragDropContext, Draggable, Droppable, type DropResult } from '../ui/SimpleDnd';

interface CustomRoleManagerDialogProps {
  open: boolean;
  roomSlug: string | null;
  onClose: () => void;
}

export function CustomRoleManagerDialog({
  open,
  roomSlug,
  onClose,
}: CustomRoleManagerDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const fetchCustomRoles = useWorkspaceStore((state) => state.fetchCustomRoles);
  const createCustomRole = useWorkspaceStore((state) => state.createCustomRole);
  const updateCustomRole = useWorkspaceStore((state) => state.updateCustomRole);
  const deleteCustomRole = useWorkspaceStore((state) => state.deleteCustomRole);
  const reorderCustomRoles = useWorkspaceStore((state) => state.reorderCustomRoles);
  const customRolesByRoom = useWorkspaceStore((state) => state.customRolesByRoom);

  const [roles, setRoles] = useState<CustomRoleWithMemberCount[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<CustomRole | null>(null);
  const [creatingRole, setCreatingRole] = useState(false);

  useEffect(() => {
    if (open && roomSlug) {
      loadRoles();
    }
  }, [open, roomSlug]);

  useEffect(() => {
    if (roomSlug && !loading) {
      // Load fresh data with member counts
      loadRoles();
    }
  }, [roomSlug]);

  useEffect(() => {
    if (roomSlug) {
      // Update from store when it changes
      const roomRoles = customRolesByRoom[roomSlug] ?? [];
      // We'll get member_count from the API response, but for now use 0
      const rolesWithCount: CustomRoleWithMemberCount[] = roomRoles.map((r) => ({
        ...r,
        member_count: 0, // Will be updated from API
      }));
      setRoles(rolesWithCount);
    }
  }, [roomSlug, customRolesByRoom]);

  const loadRoles = async () => {
    if (!roomSlug) return;
    setLoading(true);
    setError(null);
    try {
      const rolesWithCount = await apiFetchCustomRoles(roomSlug);
      setRoles(rolesWithCount);
      // Also update store
      await fetchCustomRoles(roomSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('roles.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setCreatingRole(true);
    setEditingRole(null);
  };

  const handleEdit = (role: CustomRole) => {
    setEditingRole(role);
    setCreatingRole(false);
  };

  const handleDelete = async (roleId: number) => {
    if (!roomSlug) return;
    if (!confirm(t('roles.deleteConfirm'))) return;

    try {
      await deleteCustomRole(roomSlug, roleId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('roles.deleteFailed'));
    }
  };

  const handleEditorClose = () => {
    setEditingRole(null);
    setCreatingRole(false);
  };

  const handleEditorSave = async (roleData: Partial<CustomRole>) => {
    if (!roomSlug) return;

    try {
      if (editingRole) {
        await updateCustomRole(roomSlug, editingRole.id, roleData);
      } else {
        await createCustomRole(roomSlug, roleData as any);
      }
      handleEditorClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('roles.saveFailed'));
    }
  };

  const handleDragEnd = useCallback(
    async (result: DropResult) => {
      if (!roomSlug || !result.destination || result.type !== 'ROLE') {
        return;
      }

      const sortedRoles = [...roles].sort((a, b) => b.position - a.position);
      const reordered = [...sortedRoles];
      const [moved] = reordered.splice(result.source.index, 1);
      reordered.splice(result.destination.index, 0, moved);

      // Create reorder payload with new positions (higher position = displayed first)
      const reorderPayload: CustomRoleReorderEntry[] = reordered.map((role, index) => ({
        id: role.id,
        position: reordered.length - index - 1, // Reverse: first item gets highest position
      }));

      try {
        await reorderCustomRoles(roomSlug, reorderPayload);
        // Reload roles to get updated positions
        setLoading(true);
        setError(null);
        try {
          const rolesWithCount = await apiFetchCustomRoles(roomSlug);
          setRoles(rolesWithCount);
          await fetchCustomRoles(roomSlug);
        } catch (err) {
          setError(err instanceof Error ? err.message : t('roles.loadFailed'));
        } finally {
          setLoading(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('roles.reorderFailed', { defaultValue: 'Не удалось изменить порядок ролей' }));
      }
    },
    [roomSlug, roles, reorderCustomRoles, fetchCustomRoles, t],
  );

  if (!open || !roomSlug || typeof document === 'undefined') {
    return null;
  }

  const sortedRoles = [...roles].sort((a, b) => b.position - a.position);

  return createPortal(
    <>
      <div className="modal-overlay" role="presentation" onClick={onClose} />
      <div
        className="server-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-role-manager-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id="custom-role-manager-title">{t('roles.customRolesTitle', { defaultValue: 'Кастомные роли' })}</h2>
            <p className="modal-description">
              {t('roles.customRolesSubtitle', { defaultValue: 'Создавайте и управляйте ролями для вашей комнаты' })}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              className="primary button-with-icon"
              onClick={handleCreate}
              aria-label={t('roles.createRole', { defaultValue: 'Создать роль' })}
            >
              <PlusIcon size={16} strokeWidth={1.8} />
              {t('roles.createRole', { defaultValue: 'Создать роль' })}
            </button>
            <button type="button" className="ghost" onClick={onClose} aria-label={t('common.close')}>
              {t('common.close')}
            </button>
          </div>
        </header>
        {error && (
          <p className="auth-form__error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-body">
          {loading ? (
            <p>{t('common.loading')}</p>
          ) : sortedRoles.length === 0 ? (
            <p className="permission-empty">{t('roles.noRoles', { defaultValue: 'Нет созданных ролей' })}</p>
          ) : (
            <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId="roles" type="ROLE">
                {(provided) => (
                  <div
                    {...provided.droppableProps}
                    ref={provided.innerRef}
                    className="role-list"
                    style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
                  >
                    {sortedRoles.map((role, index) => (
                      <Draggable key={role.id} draggableId={`role-${role.id}`} index={index}>
                        {(provided, snapshot) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            className="role-item"
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '0.75rem',
                              border: '1px solid var(--color-border)',
                              borderRadius: 'var(--radius-sm)',
                              backgroundColor: snapshot.isDragging
                                ? 'var(--color-surface-hover)'
                                : 'var(--color-surface)',
                              opacity: snapshot.isDragging ? 0.8 : 1,
                              cursor: snapshot.isDragging ? 'grabbing' : 'grab',
                              transition: 'background-color var(--transition-fast)',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1 }}>
                              <div
                                {...provided.dragHandleProps}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  cursor: 'grab',
                                  color: 'var(--color-text-muted)',
                                  padding: '0.25rem',
                                }}
                                aria-label={t('roles.dragToReorder', { defaultValue: 'Перетащите для изменения порядка' })}
                              >
                                <GripVerticalIcon size={16} strokeWidth={2} />
                              </div>
                              <RoleBadge role={role} />
                              <span style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
                                {role.member_count ?? 0} {t('roles.members', { defaultValue: 'участников' })}
                              </span>
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                              <button
                                type="button"
                                className="ghost button-with-icon"
                                onClick={() => handleEdit(role)}
                                aria-label={t('common.edit')}
                              >
                                <PencilIcon size={16} strokeWidth={1.8} />
                              </button>
                              <button
                                type="button"
                                className="ghost button-with-icon"
                                onClick={() => handleDelete(role.id)}
                                aria-label={t('common.delete')}
                              >
                                <TrashIcon size={16} strokeWidth={1.8} />
                              </button>
                            </div>
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>
          )}
        </div>
      </div>
      {(editingRole || creatingRole) && (
        <CustomRoleEditor
          open={true}
          roomSlug={roomSlug}
          role={editingRole ?? undefined}
          onClose={handleEditorClose}
          onSave={handleEditorSave}
        />
      )}
    </>,
    document.body,
  );
}

