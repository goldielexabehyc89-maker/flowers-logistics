/**
 * Экран «Сотрудники и курьеры».
 *
 * Использует уже существующий API. Физического удаления нет: доступны заморозка
 * и разморозка. Сервер ограничивает выборку логиста обычными курьерами —
 * интерфейс это не подменяет, а лишь не показывает лишних элементов управления.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  formatMoscowDateTime,
  ROLE_LABELS,
  USER_STATUS_LABELS,
  VEHICLE_TYPE_LABELS,
  type Role,
  type UserStatus,
} from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  Pagination,
  Select,
  StatusBadge,
  type StatusTone,
} from '../../ui/components';
import { OneTimeCodeModal, type OneTimeCode } from './OneTimeCodeModal';
import { UserFormModal, type UserFormValues } from './UserFormModal';
import {
  ACTION_LABELS,
  type ActivationCodeResponse,
  type CreatedUserResponse,
  type HistoryEntry,
  type UserListResponse,
  type UserView,
} from './types';
import './users.css';

const PAGE_SIZE = 25;

const STATUS_TONES: Record<UserStatus, StatusTone> = {
  ACTIVE: 'success',
  PENDING_ACTIVATION: 'warning',
  FROZEN: 'neutral',
};

function formatDate(value: string): string {
  return formatMoscowDateTime(value);
}

type PendingConfirm =
  | { kind: 'freeze'; user: UserView }
  | { kind: 'unfreeze'; user: UserView }
  | { kind: 'reset-pin'; user: UserView }
  | { kind: 'reissue'; user: UserView };

export function UsersScreen(): React.JSX.Element {
  const { client, user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const isAdmin = currentUser?.roles.includes('ADMIN') === true;

  const [status, setStatus] = useState<UserStatus>('ACTIVE');
  const [role, setRole] = useState<Role | ''>('');
  const [offset, setOffset] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UserView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [oneTimeCode, setOneTimeCode] = useState<OneTimeCode | null>(null);
  const [historyFor, setHistoryFor] = useState<UserView | null>(null);

  const listKey = ['users', status, role, offset] as const;

  const query = useQuery({
    queryKey: listKey,
    queryFn: () => {
      const params = new URLSearchParams({
        status,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (role !== '') {
        params.set('role', role);
      }
      return client.get<UserListResponse>(`/api/users?${params.toString()}`);
    },
  });

  /** После любой успешной операции списки перезапрашиваются без перезагрузки страницы. */
  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const describe = (error: unknown): string =>
    error instanceof ApiError ? error.message : 'Нет связи с сервисом.';

  const createMutation = useMutation({
    mutationFn: (values: UserFormValues) =>
      client.post<CreatedUserResponse>('/api/users', {
        phone: values.phone,
        fullName: values.fullName,
        roles: isAdmin ? values.roles : ['COURIER'],
        ...(values.comment === '' ? {} : { comment: values.comment }),
        ...(values.roles.includes('COURIER')
          ? { defaultVehicleType: values.defaultVehicleType }
          : {}),
      }),
    onSuccess: async (result) => {
      setFormOpen(false);
      setFormError(null);
      // Код живёт только в state окна и нигде не кэшируется.
      setOneTimeCode({
        code: result.activationCode,
        expiresAt: result.expiresAt,
        personName: result.user.fullName,
        reason: 'created',
      });
      await invalidate();
    },
    onError: (error) => setFormError(describe(error)),
  });

  const updateMutation = useMutation({
    mutationFn: (values: UserFormValues) => {
      if (editing === null) {
        throw new Error('нет редактируемой записи');
      }
      return client.patch<{ user: UserView }>(`/api/users/${editing.id}`, {
        version: editing.version,
        fullName: values.fullName,
        phone: values.phone,
        comment: values.comment === '' ? null : values.comment,
        ...(isAdmin ? { roles: values.roles } : {}),
        ...(values.roles.includes('COURIER')
          ? { defaultVehicleType: values.defaultVehicleType }
          : {}),
      });
    },
    onSuccess: async () => {
      setFormOpen(false);
      setEditing(null);
      setFormError(null);
      showToast('Изменения сохранены', 'success');
      await invalidate();
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409 && editing !== null) {
        // Чужие изменения не перетираются. Форма перезаряжается актуальными данными
        // вместе с новой версией записи — иначе повторное сохранение снова дало бы 409.
        try {
          const fresh = await client.get<{ user: UserView }>(`/api/users/${editing.id}`);
          setEditing(fresh.user);
          setFormError(
            'Запись изменена другим пользователем. Загружены актуальные данные — проверьте их и сохраните ещё раз.',
          );
        } catch {
          setFormError(
            'Запись изменена другим пользователем. Не удалось загрузить актуальные данные, закройте окно и откройте карточку заново.',
          );
        }
        await invalidate();
        return;
      }
      setFormError(describe(error));
    },
  });

  const actionMutation = useMutation({
    mutationFn: async (pending: PendingConfirm) => {
      const { user } = pending;
      switch (pending.kind) {
        case 'freeze':
          return { kind: pending.kind, data: await client.post(`/api/users/${user.id}/freeze`) };
        case 'unfreeze':
          return { kind: pending.kind, data: await client.post(`/api/users/${user.id}/unfreeze`) };
        case 'reset-pin':
          return {
            kind: pending.kind,
            data: await client.post<ActivationCodeResponse>(`/api/users/${user.id}/reset-pin`),
          };
        case 'reissue':
          return {
            kind: pending.kind,
            data: await client.post<ActivationCodeResponse>(
              `/api/users/${user.id}/activation-code/reissue`,
            ),
          };
      }
    },
    // Результат связывается с АРГУМЕНТОМ мутации, а не с текущим состоянием:
    // окно подтверждения могло закрыться, пока запрос выполнялся, и одноразовый код,
    // уже созданный на сервере, оказался бы потерян навсегда.
    onSuccess: async (result, variables) => {
      setConfirm(null);
      if (result === undefined) {
        return;
      }

      if (result.kind === 'reset-pin' || result.kind === 'reissue') {
        const payload = result.data as ActivationCodeResponse;
        setOneTimeCode({
          code: payload.activationCode,
          expiresAt: payload.expiresAt,
          personName: variables.user.fullName,
          reason: result.kind === 'reset-pin' ? 'pin-reset' : 'reissued',
        });
      } else {
        showToast(
          result.kind === 'freeze' ? 'Сотрудник заморожен' : 'Сотрудник разморожен',
          'success',
        );
      }

      await invalidate();
    },
    onError: (error) => {
      setConfirm(null);
      showToast(describe(error), 'error');
    },
  });

  const historyQuery = useQuery({
    queryKey: ['user-history', historyFor?.id],
    queryFn: () => client.get<{ items: HistoryEntry[] }>(`/api/users/${historyFor?.id}/history`),
    enabled: historyFor !== null,
  });

  const items = query.data?.items ?? [];

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <h2>Сотрудники и курьеры</h2>
          <p className="muted text-sm">
            Сотрудники не удаляются: недоступность выражается заморозкой, её можно снять.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setEditing(null);
            setFormError(null);
            setFormOpen(true);
          }}
        >
          Добавить
        </Button>
      </div>

      <section className="card">
        <div className="filters">
          <Field label="Статус">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as UserStatus);
                  setOffset(0);
                }}
              >
                <option value="ACTIVE">Активные</option>
                <option value="PENDING_ACTIVATION">Ожидают активации</option>
                <option value="FROZEN">Замороженные</option>
              </Select>
            )}
          </Field>

          {isAdmin && (
            <Field label="Роль">
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={role}
                  onChange={(event) => {
                    setRole(event.target.value as Role | '');
                    setOffset(0);
                  }}
                >
                  <option value="">Любая</option>
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
      </section>

      {query.isLoading && <LoadingState />}
      {query.isError && (
        <ErrorState description={describe(query.error)} onRetry={() => void query.refetch()} />
      )}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="Никого не найдено"
          description="Измените фильтры или добавьте сотрудника."
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ФИО</th>
                  <th>Телефон</th>
                  <th>Роли</th>
                  <th>Статус</th>
                  <th>Транспорт</th>
                  <th>Изменён</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.fullName}</td>
                    <td className="nowrap">{item.phone}</td>
                    <td>
                      {/* Подписи берутся только для известных ролей: обращение
                          ROLE_LABELS[неизвестная] дало бы пустую ячейку. */}
                      {item.roles.map((role) => ROLE_LABELS[role]).join(', ') ||
                        (item.hasUnsupportedRoles ? '—' : '')}
                      {item.hasUnsupportedRoles && (
                        <div className="text-sm muted">Роли заданы более новой версией</div>
                      )}
                    </td>
                    <td>
                      <StatusBadge tone={STATUS_TONES[item.status]}>
                        {USER_STATUS_LABELS[item.status]}
                      </StatusBadge>
                    </td>
                    <td>
                      {item.courierProfile === null
                        ? '—'
                        : VEHICLE_TYPE_LABELS[item.courierProfile.defaultVehicleType]}
                    </td>
                    <td className="nowrap">{formatDate(item.updatedAt)}</td>
                    <td>
                      <div className="row">
                        <Button
                          disabled={item.hasUnsupportedRoles}
                          title={
                            item.hasUnsupportedRoles
                              ? 'Роли этого пользователя заданы в более новой версии приложения'
                              : undefined
                          }
                          onClick={() => {
                            setEditing(item);
                            setFormError(null);
                            setFormOpen(true);
                          }}
                        >
                          Изменить
                        </Button>
                        {item.status === 'FROZEN' ? (
                          <Button onClick={() => setConfirm({ kind: 'unfreeze', user: item })}>
                            Разморозить
                          </Button>
                        ) : (
                          <Button onClick={() => setConfirm({ kind: 'freeze', user: item })}>
                            Заморозить
                          </Button>
                        )}
                        {item.status !== 'FROZEN' && (
                          <Button onClick={() => setConfirm({ kind: 'reset-pin', user: item })}>
                            Сбросить PIN
                          </Button>
                        )}
                        {item.status === 'PENDING_ACTIVATION' && (
                          <Button onClick={() => setConfirm({ kind: 'reissue', user: item })}>
                            Новый код
                          </Button>
                        )}
                        <Button onClick={() => setHistoryFor(item)}>История</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            offset={offset}
            limit={PAGE_SIZE}
            total={query.data.total}
            onChange={setOffset}
          />
        </>
      )}

      <UserFormModal
        open={formOpen}
        mode={editing === null ? 'create' : 'edit'}
        canAssignRoles={isAdmin}
        initial={editing}
        busy={createMutation.isPending || updateMutation.isPending}
        error={formError}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
          setFormError(null);
        }}
        onSubmit={(values) => {
          if (editing === null) {
            createMutation.mutate(values);
          } else {
            updateMutation.mutate(values);
          }
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === 'freeze'
            ? 'Заморозить сотрудника?'
            : confirm?.kind === 'unfreeze'
              ? 'Разморозить сотрудника?'
              : confirm?.kind === 'reset-pin'
                ? 'Сбросить PIN?'
                : 'Перевыпустить код активации?'
        }
        description={
          confirm?.kind === 'freeze' ? (
            <>
              Вход будет закрыт немедленно, все сессии на всех устройствах — отозваны. Данные и
              история сохраняются, сотрудника можно разморозить позже.
            </>
          ) : confirm?.kind === 'unfreeze' ? (
            <>
              Сотрудник снова сможет войти. Ранее отозванные сессии не восстанавливаются —
              потребуется новый вход.
            </>
          ) : confirm?.kind === 'reset-pin' ? (
            <>
              Текущий PIN будет удалён, все сессии отозваны. Сотрудник получит одноразовый код и
              задаст новый PIN. Код показывается один раз.
            </>
          ) : (
            <>Предыдущий код перестанет действовать. Новый код показывается один раз.</>
          )
        }
        confirmLabel={
          confirm?.kind === 'freeze'
            ? 'Заморозить'
            : confirm?.kind === 'unfreeze'
              ? 'Разморозить'
              : confirm?.kind === 'reset-pin'
                ? 'Сбросить PIN'
                : 'Перевыпустить'
        }
        destructive={confirm?.kind === 'freeze' || confirm?.kind === 'reset-pin'}
        busy={actionMutation.isPending}
        onConfirm={() => {
          if (confirm !== null) {
            actionMutation.mutate(confirm);
          }
        }}
        onCancel={() => {
          // Пока операция выполняется, окно закрыть нельзя: результат может
          // содержать одноразовый код, который показывается только один раз.
          if (!actionMutation.isPending) {
            setConfirm(null);
          }
        }}
      />

      <OneTimeCodeModal value={oneTimeCode} onClose={() => setOneTimeCode(null)} />

      <Modal
        open={historyFor !== null}
        title={`История: ${historyFor?.fullName ?? ''}`}
        onClose={() => setHistoryFor(null)}
      >
        {historyQuery.isLoading && <LoadingState />}
        {historyQuery.isError && <ErrorState onRetry={() => void historyQuery.refetch()} />}
        {historyQuery.data !== undefined && historyQuery.data.items.length === 0 && (
          <EmptyState title="Записей пока нет" />
        )}
        {historyQuery.data !== undefined && historyQuery.data.items.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Действие</th>
                  <th>Источник</th>
                </tr>
              </thead>
              <tbody>
                {historyQuery.data.items.map((entry) => (
                  <tr key={entry.id}>
                    <td className="nowrap">{formatDate(entry.occurredAt)}</td>
                    <td>{ACTION_LABELS[entry.action] ?? entry.action}</td>
                    <td>{entry.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
