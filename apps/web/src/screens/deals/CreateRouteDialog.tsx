/**
 * Подтверждение создания маршрута из выбранных сделок.
 *
 * Раньше «Создать маршрут вручную» молча создавало черновик и уводило со
 * страницы: логист узнавал состав будущего маршрута уже в «Маршрутизации».
 * Теперь он видит список до создания и решает, что именно создать.
 *
 * Два исхода — черновик и маршрутный лист — это один и тот же серверный вызов
 * с разным режимом, а не два параллельных пути.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { Button, Field, Modal } from '../../ui/components';
import { CourierCombobox } from '../logistics/CourierCombobox';
import { courierIdFor, type CourierOption } from './courier-picker';
import type { DealCard } from './selection';

export interface CreateRouteDialogProps {
  /** Выбранные заказы в порядке выбора: он же порядок остановок. */
  selected: readonly string[];
  /** Карточки загруженных страниц: из них берутся номер и адрес. */
  known: readonly DealCard[];
  pending: boolean;
  onClose: () => void;
  onCreate: (input: { courierUserId: string | null; mode: 'DRAFT' | 'SHEET' }) => void;
}

export function CreateRouteDialog({
  selected,
  known,
  pending,
  onClose,
  onCreate,
}: CreateRouteDialogProps): React.JSX.Element {
  const { client } = useAuth();
  const [courier, setCourier] = useState<CourierOption | null>(null);

  const couriers = useQuery({
    queryKey: ['couriers-for-routes'],
    queryFn: () =>
      client.get<{ items: CourierOption[] }>('/api/users?role=COURIER&status=ACTIVE&limit=100'),
  });

  /*
   * Состав будущего маршрута.
   *
   * Выбор мог захватить заказы со страниц, которые ещё не загружены: о них
   * честно говорится числом, а не показывается пустая строка.
   */
  const knownById = useMemo(() => new Map(known.map((card) => [card.id, card])), [known]);
  const missing = useMemo(() => selected.filter((id) => !knownById.has(id)), [selected, knownById]);

  /*
   * Заказы со страниц, которые ещё не загружены.
   *
   * Их номер и адрес берутся существующим read-only контрактом заказа:
   * показывать в списке «заказ с незагруженной страницы» значило бы просить
   * человека подтвердить состав, которого он не видит. Сервер при этом
   * не менялся.
   */
  const fetched = useQuery({
    queryKey: ['create-route-orders', missing],
    enabled: missing.length > 0,
    queryFn: async () => {
      const rows = await Promise.all(
        missing.map((id) =>
          client.get<{ id: string; number: string; address: string | null }>(`/api/orders/${id}`),
        ),
      );
      return new Map(rows.map((row) => [row.id, row]));
    },
  });

  const cards = useMemo(
    () =>
      selected.map((id) => {
        const card = knownById.get(id);
        if (card !== undefined) {
          return { number: card.number, address: card.address };
        }
        const row = fetched.data?.get(id);
        return row === undefined ? null : { number: row.number, address: row.address };
      }),
    [selected, knownById, fetched.data],
  );
  const unknownCount = cards.filter((card) => card === null).length;

  return (
    <Modal
      open
      title="Создание маршрута"
      onClose={onClose}
      dismissible={!pending}
      testId="create-route-dialog"
    >
      <div className="stack">
        <p className="text-sm muted" data-testid="create-route-count">
          Заказов в маршруте: {selected.length}. Порядок остановок — порядок выбора.
        </p>

        {/*
          Порядковый номер рисуется сам — списку он не нужен.
          Раньше здесь был `ol` со своей нумерацией поверх нашей, и строка
          читалась как «1. 1 заказ…».
        */}
        <ul className="create-route__orders" data-testid="create-route-orders">
          {cards.map((card, index) => (
            <li key={selected[index] ?? index} className="create-route__order">
              <span className="create-route__position">{index + 1}</span>
              {card === null ? (
                <span className="muted">
                  {fetched.isPending ? 'загружаем…' : 'заказ недоступен'}
                </span>
              ) : (
                <>
                  <span className="create-route__number">{card.number}</span>
                  <span className="create-route__address">{card.address ?? 'Адрес не указан'}</span>
                </>
              )}
            </li>
          ))}
        </ul>

        {unknownCount > 0 && (
          <p className="text-sm muted">
            Из них {unknownCount} со страниц, которые ещё не загружены: они всё равно войдут в
            маршрут.
          </p>
        )}

        {/*
          Курьер необязателен: маршрутный лист без курьера — обычное рабочее
          состояние, его назначают ближе к отгрузке.
        */}
        <Field label="Курьер" hint="Необязательно. Поиск по имени или телефону">
          {() => (
            <CourierCombobox
              options={couriers.data?.items ?? []}
              value={courier}
              disabled={pending}
              testId="create-route-courier"
              onChange={setCourier}
            />
          )}
        </Field>

        <div className="modal__footer">
          <Button onClick={onClose} disabled={pending} data-testid="create-route-cancel">
            Отмена
          </Button>
          <Button
            data-testid="create-route-draft"
            disabled={pending}
            onClick={() => onCreate({ courierUserId: courierIdFor(courier), mode: 'DRAFT' })}
          >
            Создать черновик
          </Button>
          <Button
            variant="primary"
            data-testid="create-route-sheet"
            disabled={pending}
            onClick={() => onCreate({ courierUserId: courierIdFor(courier), mode: 'SHEET' })}
          >
            Создать МЛ
          </Button>
        </div>
      </div>
    </Modal>
  );
}
