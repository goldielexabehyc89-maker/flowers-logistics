/**
 * Настройки финансового учёта: тарифы курьера и геометрия МКАД.
 *
 * Раздел администратора. Ставки и геометрию задаёт человек: значения по
 * умолчанию здесь не подставляются вовсе, потому что от них зависят деньги,
 * а придуманная ставка выглядит на экране ровно так же, как настоящая.
 *
 * Пока тариф или геометрия не настроены, раздел говорит об этом словами и
 * называет последствие: без тарифа маршрут нельзя подтвердить, без геометрии
 * не считается расстояние за МКАД.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { formatDate, moscowToday } from '../routing/routing';
import './finance-settings.css';

interface TariffView {
  id: string;
  kind: 'REGULAR' | 'HOLIDAY';
  effectiveFrom: string;
  effectiveTo: string | null;
  perOrderWalkMinor: string;
  perOrderCarMinor: string;
  perKmMinor: string;
  note: string | null;
  createdAt: string;
}

interface TariffsResponse {
  items: TariffView[];
  activation: { activeFrom: string | null };
  today: {
    date: string;
    perOrderWalkMinor: string | null;
    perOrderCarMinor: string | null;
    perKmMinor: string | null;
  };
}

interface RingVersion {
  id: string;
  pointCount: number;
  sha256: string;
  source: string;
  license: string | null;
  sourceDate: string | null;
  createdAt: string;
  active?: boolean;
}

/** Что именно поставлено с приложением. Правке не подлежит: только чтение. */
interface RingBundle {
  version: string;
  sha256: string;
  osmRelationId: number;
  snapshotUrl: string;
  dataDate: string;
  pointCount: number;
  lengthMeters: number;
  license: string;
  attribution: string;
}

interface RingResponse {
  configured: boolean;
  bundled: RingBundle;
  active: RingVersion | null;
  versions: RingVersion[];
}

/** Рубли человека в целые минорные единицы. Пусто — ошибка, а не ноль. */
export function toMinor(input: string): bigint | null {
  const normalized = input.replace(',', '.').trim();
  if (normalized === '' || !/^\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }
  const [whole, fraction = ''] = normalized.split('.');
  return BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** Минорные единицы человеку. */
export function fromMinor(minor: string): string {
  return `${(Number(BigInt(minor)) / 100).toFixed(2).replace('.', ',')} ₽`;
}

const KIND_LABELS: Record<string, string> = {
  REGULAR: 'Обычный',
  HOLIDAY: 'Праздничный',
};

export function FinanceSettings(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const today = moscowToday();

  const [kind, setKind] = useState<'REGULAR' | 'HOLIDAY'>('REGULAR');
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [effectiveTo, setEffectiveTo] = useState('');
  const [perOrderWalk, setPerOrderWalk] = useState('');
  const [perOrderCar, setPerOrderCar] = useState('');
  const [perKm, setPerKm] = useState('');
  const [note, setNote] = useState('');
  const [tariffError, setTariffError] = useState<string | null>(null);

  const [activeFrom, setActiveFrom] = useState(today);

  const tariffs = useQuery({
    queryKey: ['finance-tariffs'],
    queryFn: () => client.get<TariffsResponse>('/api/logistics/tariffs'),
  });

  const ring = useQuery({
    queryKey: ['finance-mkad'],
    queryFn: () => client.get<RingResponse>('/api/logistics/mkad'),
  });

  const createTariff = useMutation({
    mutationFn: (input: {
      perOrderWalkMinor: bigint;
      perOrderCarMinor: bigint;
      perKmMinor: bigint;
    }) =>
      client.post('/api/logistics/tariffs', {
        kind,
        effectiveFrom,
        effectiveTo: effectiveTo === '' ? null : effectiveTo,
        perOrderWalkMinor: input.perOrderWalkMinor.toString(),
        perOrderCarMinor: input.perOrderCarMinor.toString(),
        perKmMinor: input.perKmMinor.toString(),
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: () => {
      setPerOrderWalk('');
      setPerOrderCar('');
      setPerKm('');
      setNote('');
      setTariffError(null);
      showToast('Версия тарифа создана', 'success');
      void queryClient.invalidateQueries({ queryKey: ['finance-tariffs'] });
    },
    onError: (error: unknown) =>
      setTariffError((error as { message?: string }).message ?? 'Не удалось создать версию тарифа'),
  });

  const activate = useMutation({
    mutationFn: () => client.put('/api/logistics/ledger/activation', { activeFrom }),
    onSuccess: () => {
      showToast('Учёт включён', 'success');
      void queryClient.invalidateQueries({ queryKey: ['finance-tariffs'] });
    },
    onError: (error: unknown) =>
      showToast((error as { message?: string }).message ?? 'Не удалось включить учёт', 'error'),
  });

  const submitTariff = (): void => {
    const walk = toMinor(perOrderWalk);
    const car = toMinor(perOrderCar);
    const km = toMinor(perKm);
    if (walk === null || car === null || km === null) {
      setTariffError('Ставки задаются числом в рублях, например 250 или 250,50.');
      return;
    }
    createTariff.mutate({ perOrderWalkMinor: walk, perOrderCarMinor: car, perKmMinor: km });
  };

  const activation = tariffs.data?.activation.activeFrom ?? null;
  const currentRates = tariffs.data?.today ?? null;
  const tariffMissing = currentRates !== null && currentRates.perOrderCarMinor === null;

  return (
    <div className="stack" data-testid="finance-settings">
      <section className="card stack">
        <div>
          <h2>Тарифы курьера</h2>
          <p className="muted text-sm">
            Ставки за доставленный заказ — отдельно пешая и автомобильная — и за километр за МКАД.
            Какая из двух ставок «За заказ» применится, решает тип транспорта маршрута. Тариф
            выбирается по дате доставки и фиксируется снимком при подтверждении маршрута: изменение
            ставок не пересчитывает уже подтверждённые маршруты.
          </p>
        </div>

        {tariffs.isPending ? (
          <LoadingState title="Загружаем тарифы…" />
        ) : tariffs.isError ? (
          <ErrorState title="Не удалось загрузить тарифы" onRetry={() => void tariffs.refetch()} />
        ) : (
          <>
            <div className="finance__state" data-testid="finance-tariff-state">
              {tariffMissing ? (
                <p className="finance__warning" role="status">
                  На сегодня тариф не настроен. Пока его нет, подтвердить маршрут нельзя: система не
                  станет считать деньги по выдуманной ставке.
                </p>
              ) : (
                <p className="finance__ok" role="status">
                  Действует на {formatDate(currentRates?.date ?? today)}: за заказ пеший{' '}
                  {fromMinor(currentRates?.perOrderWalkMinor ?? '0')}, за заказ авто{' '}
                  {fromMinor(currentRates?.perOrderCarMinor ?? '0')}, за километр{' '}
                  {fromMinor(currentRates?.perKmMinor ?? '0')}.
                </p>
              )}

              {activation === null ? (
                <p className="finance__warning" role="status" data-testid="finance-ledger-off">
                  Финансовый учёт не включён: начисления не создаются, отчёт показывает прошлые
                  доставки с отметкой «Расчёт отсутствует».
                </p>
              ) : (
                <p className="muted text-sm">Учёт ведётся с {formatDate(activation)}.</p>
              )}
            </div>

            {activation === null && (
              <div className="finance__row">
                <Field label="Включить учёт с" hint="Более ранние доставки останутся без расчёта">
                  {(props) => (
                    <TextInput
                      {...props}
                      type="date"
                      value={activeFrom}
                      data-testid="finance-activation-date"
                      onChange={(event) => setActiveFrom(event.target.value)}
                    />
                  )}
                </Field>
                <Button
                  variant="primary"
                  disabled={activate.isPending}
                  data-testid="finance-activate"
                  onClick={() => activate.mutate()}
                >
                  Включить учёт
                </Button>
              </div>
            )}

            <div className="finance__row">
              <Field label="Вид">
                {(props) => (
                  <select
                    {...props}
                    className="finance__select"
                    value={kind}
                    data-testid="tariff-kind"
                    onChange={(event) => setKind(event.target.value as 'REGULAR' | 'HOLIDAY')}
                  >
                    <option value="REGULAR">Обычный</option>
                    <option value="HOLIDAY">Праздничный</option>
                  </select>
                )}
              </Field>
              <Field label="Действует с">
                {(props) => (
                  <TextInput
                    {...props}
                    type="date"
                    value={effectiveFrom}
                    data-testid="tariff-from"
                    onChange={(event) => setEffectiveFrom(event.target.value)}
                  />
                )}
              </Field>
              <Field
                label="По"
                hint={kind === 'HOLIDAY' ? 'Обязательно для праздничного' : 'Пусто — бессрочно'}
              >
                {(props) => (
                  <TextInput
                    {...props}
                    type="date"
                    value={effectiveTo}
                    data-testid="tariff-to"
                    onChange={(event) => setEffectiveTo(event.target.value)}
                  />
                )}
              </Field>
              <Field label="За заказ (пеший), ₽">
                {(props) => (
                  <TextInput
                    {...props}
                    value={perOrderWalk}
                    inputMode="decimal"
                    data-testid="tariff-per-order-walk"
                    onChange={(event) => setPerOrderWalk(event.target.value)}
                  />
                )}
              </Field>
              <Field label="За заказ (авто), ₽">
                {(props) => (
                  <TextInput
                    {...props}
                    value={perOrderCar}
                    inputMode="decimal"
                    data-testid="tariff-per-order-car"
                    onChange={(event) => setPerOrderCar(event.target.value)}
                  />
                )}
              </Field>
              <Field label="За километр, ₽">
                {(props) => (
                  <TextInput
                    {...props}
                    value={perKm}
                    inputMode="decimal"
                    data-testid="tariff-per-km"
                    onChange={(event) => setPerKm(event.target.value)}
                  />
                )}
              </Field>
              <Field label="Пояснение" hint="Необязательно">
                {(props) => (
                  <TextInput
                    {...props}
                    value={note}
                    data-testid="tariff-note"
                    onChange={(event) => setNote(event.target.value)}
                  />
                )}
              </Field>
              <Button
                variant="primary"
                disabled={createTariff.isPending}
                data-testid="tariff-submit"
                onClick={submitTariff}
              >
                Создать версию
              </Button>
            </div>

            {tariffError !== null && (
              <p className="finance__error" role="alert" data-testid="tariff-error">
                {tariffError}
              </p>
            )}

            {tariffs.data.items.length === 0 ? (
              <EmptyState
                title="Версий тарифа нет"
                description="Создайте первую версию: без неё маршруты нельзя подтверждать."
              />
            ) : (
              <div className="finance__table-wrap">
                <table className="finance__table" data-testid="tariff-list">
                  <thead>
                    <tr>
                      <th>Вид</th>
                      <th>Действует</th>
                      <th>За заказ (пеший)</th>
                      <th>За заказ (авто)</th>
                      <th>За километр</th>
                      <th>Пояснение</th>
                      <th>Создана</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tariffs.data.items.map((item) => (
                      <tr key={item.id} data-tariff-kind={item.kind}>
                        <td>
                          <StatusBadge tone={item.kind === 'HOLIDAY' ? 'warning' : 'info'}>
                            {KIND_LABELS[item.kind] ?? item.kind}
                          </StatusBadge>
                        </td>
                        <td>
                          {formatDate(item.effectiveFrom)}
                          {item.effectiveTo === null
                            ? ' — бессрочно'
                            : ` — ${formatDate(item.effectiveTo)}`}
                        </td>
                        <td>{fromMinor(item.perOrderWalkMinor)}</td>
                        <td>{fromMinor(item.perOrderCarMinor)}</td>
                        <td>{fromMinor(item.perKmMinor)}</td>
                        <td>{item.note ?? '—'}</td>
                        <td>{formatMoscowDateTime(item.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card stack">
        <div>
          <h2>Геометрия МКАД</h2>
          <p className="muted text-sm">
            От неё считается расстояние за МКАД: дорожный путь от ближайшей точки кольца до адреса.
            Точная геометрия входит в поставку приложения системным файлом; приблизительное кольцо
            система не строит, потому что от него зависят деньги.
          </p>
        </div>

        {ring.isPending ? (
          <LoadingState title="Загружаем геометрию…" />
        ) : ring.isError ? (
          <ErrorState title="Не удалось загрузить геометрию" onRetry={() => void ring.refetch()} />
        ) : (
          <>
            {ring.data.active === null ? (
              <p className="finance__warning" role="status" data-testid="mkad-missing">
                Геометрия из поставки не установлена: расстояние за МКАД не считается, и в отчёте
                такие строки показываются как «не рассчитано».
              </p>
            ) : (
              <div className="finance__state" data-testid="mkad-active">
                <p className="finance__ok">
                  Действует версия {ring.data.bundled.version}, точек:{' '}
                  {ring.data.bundled.pointCount}, длина кольца:{' '}
                  {(ring.data.bundled.lengthMeters / 1000).toFixed(1)} км.
                </p>
                <p className="muted text-sm">
                  Источник: OpenStreetMap, отношение {ring.data.bundled.osmRelationId}, снимок{' '}
                  {ring.data.bundled.snapshotUrl}. Данные на{' '}
                  {formatDate(ring.data.bundled.dataDate)}.
                </p>
                <p className="muted text-sm">
                  Лицензия: {ring.data.bundled.license}, {ring.data.bundled.attribution}.
                </p>
                <p className="muted text-sm" data-testid="mkad-sha">
                  Отпечаток: {ring.data.bundled.sha256.slice(0, 16)}…
                </p>
              </div>
            )}

            {/*
              Загрузки и правки геометрии здесь нет намеренно: кольцо входит
              в поставку системным файлом, и меняется только новой версией
              приложения. Раздел показывает состояние, а не управляет им.
            */}
            <p className="muted text-sm">
              Геометрия поставляется вместе с приложением и обновляется новой версией файла при
              обновлении. Прежние версии и снимки прошлых расчётов сохраняются. Вручную здесь
              настраиваются только стоимость километра за МКАД и период действия тарифа.
            </p>

            {ring.data.versions.length > 1 && (
              <div className="finance__table-wrap">
                <table className="finance__table" data-testid="mkad-versions">
                  <thead>
                    <tr>
                      <th>Установлена</th>
                      <th>Точек</th>
                      <th>Действует</th>
                      <th>Источник</th>
                      <th>Лицензия</th>
                      <th>Актуальна на</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ring.data.versions.map((item) => (
                      <tr key={item.id}>
                        <td>{formatMoscowDateTime(item.createdAt)}</td>
                        <td>{item.pointCount}</td>
                        <td>{item.active === true ? 'да' : '—'}</td>
                        <td>{item.source}</td>
                        <td>{item.license ?? '—'}</td>
                        <td>{item.sourceDate === null ? '—' : formatDate(item.sourceDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
