/**
 * Создание и редактирование сотрудника.
 *
 * Логисту управление ролями не показывается вовсе: он создаёт только курьеров.
 * При редактировании передаётся `version` — сервер отклонит устаревшую версию,
 * и чужие изменения не будут перезаписаны.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { ROLE_LABELS, VEHICLE_TYPE_LABELS, type Role, type VehicleType } from '@fl/shared';
import { Button, Field, Modal, Select, TextInput } from '../../ui/components';
import type { UserView } from './types';

export interface UserFormValues {
  phone: string;
  fullName: string;
  roles: Role[];
  defaultVehicleType: VehicleType;
  comment: string;
}

const EMPTY: UserFormValues = {
  phone: '',
  fullName: '',
  roles: ['COURIER'],
  defaultVehicleType: 'CAR',
  comment: '',
};

export function UserFormModal({
  open,
  mode,
  canAssignRoles,
  assignable,
  initial,
  defaultRole,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  canAssignRoles: boolean;
  /**
   * Роли, которые актор вправе назначить. Приходят из общей матрицы прав
   * (`assignableRoles`), поэтому у управляющего здесь нет ADMIN, а у логиста
   * галочки ролей не показываются вовсе (`canAssignRoles` = false).
   */
  assignable: readonly Role[];
  initial: UserView | null;
  /**
   * Роль нового сотрудника: та, вкладка которой открыта.
   *
   * Человек уже сказал, кого заводит, выбрав вкладку. Спрашивать это второй
   * раз галочками — заставлять его повторяться и оставлять возможность
   * завести флориста, стоя в списке курьеров.
   */
  defaultRole: Role;
  busy: boolean;
  error: string | null;
  onSubmit: (values: UserFormValues) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [values, setValues] = useState<UserFormValues>(EMPTY);

  useEffect(() => {
    if (!open) {
      return;
    }
    setValues(
      initial === null
        ? { ...EMPTY, roles: [defaultRole] }
        : {
            phone: initial.phone,
            fullName: initial.fullName,
            roles: initial.roles,
            defaultVehicleType: initial.courierProfile?.defaultVehicleType ?? 'CAR',
            comment: initial.comment ?? '',
          },
    );
  }, [open, initial, defaultRole]);

  const toggleRole = (role: Role): void => {
    setValues((current) => ({
      ...current,
      roles: current.roles.includes(role)
        ? current.roles.filter((item) => item !== role)
        : [...current.roles, role],
    }));
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit(values);
  };

  const isCourier = values.roles.includes('COURIER');

  return (
    <Modal
      open={open}
      title={mode === 'create' ? 'Новый сотрудник' : 'Изменение данных'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy} form="user-form" type="submit">
            {mode === 'create' ? 'Создать' : 'Сохранить'}
          </Button>
        </>
      }
    >
      <form id="user-form" className="stack" onSubmit={handleSubmit} noValidate>
        <Field label="ФИО">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              value={values.fullName}
              onChange={(event) => setValues({ ...values, fullName: event.target.value })}
              maxLength={200}
              required
            />
          )}
        </Field>

        <Field label="Телефон" hint="Российский номер, например +7 916 123-45-67">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="tel"
              inputMode="tel"
              value={values.phone}
              onChange={(event) => setValues({ ...values, phone: event.target.value })}
              required
            />
          )}
        </Field>

        {canAssignRoles ? (
          <fieldset className="fieldset">
            <legend className="field__label">Роли</legend>
            {assignable.map((role) => (
              <label key={role} className="checkbox">
                <input
                  type="checkbox"
                  checked={values.roles.includes(role)}
                  onChange={() => toggleRole(role)}
                />
                {ROLE_LABELS[role]}
              </label>
            ))}
          </fieldset>
        ) : (
          // Логист создаёт только курьеров: выбор ролей ему не показывается.
          <p className="text-sm muted">Роль: {ROLE_LABELS.COURIER}</p>
        )}

        {isCourier && (
          <Field label="Транспорт по умолчанию">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={values.defaultVehicleType}
                onChange={(event) =>
                  setValues({ ...values, defaultVehicleType: event.target.value as VehicleType })
                }
              >
                {Object.entries(VEHICLE_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        <Field label="Комментарий" hint="Необязательно">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              value={values.comment}
              onChange={(event) => setValues({ ...values, comment: event.target.value })}
              maxLength={2000}
            />
          )}
        </Field>

        {error !== null && (
          <p className="auth__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
