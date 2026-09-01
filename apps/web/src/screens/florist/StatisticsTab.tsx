/**
 * Вкладка «Статистика» смен флориста. Только для администратора (сервер
 * подтверждает 403 остальным). Период по умолчанию — текущая неделя.
 *
 * Показатели, которые честно восстановимы из прежней истории, показываются за
 * любые даты; разбиение простоя и деньги накапливаются вперёд, поэтому до даты
 * начала точного накопления помечаются как неполные, а не заполняются нулём.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatCalendarDate, moscowToday, shiftCalendarDate } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { EmptyState, ErrorState, Field, LoadingState, TextInput } from '../../ui/components';

interface Comparison {
  shiftDurationMinutes: number;
  workingMinutes: number;
  idleWithQueueMinutes: number | null;
  idleWithoutQueueMinutes: number | null;
  uniqueAssembledCount: number;
  reassemblyCount: number;
  totalSumMinor: string | null;
  ordersPerHour: number;
  rublesPerHour: number | null;
  avgAssemblyMinutes: number | null;
  medianAssemblyMinutes: number | null;
}

interface StatRow extends Comparison {
  floristId: string;
  floristName: string;
  /** Московская дата начала самой ранней смены периода — под именем. */
  firstShiftDate: string | null;
  idleIncomplete: boolean;
  moneyIncomplete: boolean;
  idleWithQueuePercent: number | null;
  idleWithoutQueuePercent: number | null;
  comparison: Comparison;
}

interface StatResponse {
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  accurateFrom: string | null;
  rows: StatRow[];
}

/** Начало текущей недели (понедельник) по Москве. */
function weekStart(today: string): string {
  const dow = new Date(`${today}T12:00:00.000Z`).getUTCDay(); // 0=вс
  const backToMonday = dow === 0 ? 6 : dow - 1;
  return shiftCalendarDate(today, -backToMonday);
}

/** Минуты → «Ч ч ММ м» либо «ММ м». */
function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} ч ${m.toString().padStart(2, '0')} м` : `${m} м`;
}

function formatMinutes(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} м`;
}

function formatRubles(minor: string | null): string {
  if (minor === null) return '—';
  return `${(Number(minor) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/** Знаковая дельта числа к предыдущему периоду и её направление для цвета. */
function deltaParts(
  current: number,
  previous: number,
): {
  text: string;
  direction: 'up' | 'down' | 'flat';
} {
  const abs = current - previous;
  const rounded = abs.toFixed(abs % 1 === 0 ? 0 : 1);
  const sign = abs > 0 ? '+' : '';
  return {
    text: `${sign}${rounded}`,
    direction: abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat',
  };
}

/** Простой словами: длительность и доля, либо «неполно», если данных нет. */
function idleLabel(minutes: number | null, percent: number | null, incomplete: boolean): string {
  if (incomplete) {
    return 'неполно';
  }
  return `${formatDuration(minutes ?? 0)} · ${percent ?? 0}%`;
}

/**
 * Столбцы таблицы. Связанные показатели объединены в один столбец с главным
 * значением и подписью под ним — как на эталоне: «Смена / работа», «Простой:
 * очередь / пусто», «Сборка: ср. / медиана».
 */
const STAT_COLUMNS: readonly { label: string; align: 'start' | 'end' }[] = [
  { label: 'Флорист', align: 'start' },
  { label: 'Смена / работа', align: 'end' },
  { label: 'Простой: очередь / пусто', align: 'end' },
  { label: 'Собрано', align: 'end' },
  { label: 'Сумма', align: 'end' },
  { label: 'Заказов/ч', align: 'end' },
  { label: '₽/ч', align: 'end' },
  { label: 'Сборка: ср. / медиана', align: 'end' },
  { label: 'Δ собрано', align: 'end' },
];

/** Ячейка с главным значением и подписью под ним (второй показатель группы). */
function groupCell(main: React.ReactNode, sub: React.ReactNode): React.JSX.Element {
  return (
    <div className="stats__cell stats__cell--end">
      <span className="stats__big">{main}</span>
      <span className="stats__sub">{sub}</span>
    </div>
  );
}

/** Ячейка с одним значением. */
function valueCell(value: React.ReactNode): React.JSX.Element {
  return (
    <div className="stats__cell stats__cell--end">
      <span className="stats__big">{value}</span>
    </div>
  );
}

export function StatisticsTab(): React.JSX.Element {
  const { client } = useAuth();
  const today = moscowToday();
  const [from, setFrom] = useState(() => weekStart(today));
  const [to, setTo] = useState(today);

  const valid = from <= to;
  const stats = useQuery({
    queryKey: ['florist-statistics', from, to],
    queryFn: () =>
      client.get<StatResponse>(
        `/api/florist/statistics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
    enabled: valid,
  });

  const boundaryNote = useMemo(() => {
    const accurate = stats.data?.accurateFrom ?? null;
    if (accurate === null) {
      return 'Точное накопление ещё не начиналось: простой и деньги пока неполны для всех дат.';
    }
    return `Точное накопление простоя и денег ведётся с ${formatCalendarDate(accurate)}. За более ранние даты эти показатели помечены как неполные.`;
  }, [stats.data]);

  return (
    <div className="stack" data-testid="florist-stats">
      <div className="card stack">
        <div>
          <h3>Статистика смен</h3>
          <p className="muted text-sm">{boundaryNote}</p>
        </div>
        <div className="row">
          <Field label="С">
            {(props) => (
              <TextInput
                {...props}
                type="date"
                value={from}
                data-testid="stats-from"
                onChange={(event) => setFrom(event.target.value)}
              />
            )}
          </Field>
          <Field label="По">
            {(props) => (
              <TextInput
                {...props}
                type="date"
                value={to}
                data-testid="stats-to"
                onChange={(event) => setTo(event.target.value)}
              />
            )}
          </Field>
        </div>
        {!valid && (
          <p className="finance__error" role="alert">
            Конец периода раньше его начала.
          </p>
        )}
      </div>

      {!valid ? null : stats.isPending ? (
        <LoadingState title="Считаем статистику…" />
      ) : stats.isError ? (
        <ErrorState title="Не удалось загрузить статистику" onRetry={() => void stats.refetch()} />
      ) : stats.data.rows.length === 0 ? (
        <EmptyState title="Смен нет" description="За выбранный период смен не было." />
      ) : (
        <div className="stats__scroll" data-testid="stats-table">
          <div className="stats__grid">
            <div className="stats__head">
              {STAT_COLUMNS.map((col) => (
                <span
                  key={col.label}
                  className={`stats__cell stats__cell--${col.align} stats__colhead`}
                >
                  {col.label}
                </span>
              ))}
            </div>

            {stats.data.rows.map((row) => {
              const d = deltaParts(row.uniqueAssembledCount, row.comparison.uniqueAssembledCount);
              const incomplete = row.idleIncomplete || row.moneyIncomplete;
              return (
                <article
                  key={row.floristId}
                  className={incomplete ? 'stats__row stats__row--incomplete' : 'stats__row'}
                  data-testid="stats-row"
                  data-florist={row.floristId}
                >
                  <div className="stats__cell stats__cell--start stats__name">
                    <strong>{row.floristName}</strong>
                    <span className="stats__submeta">
                      {row.firstShiftDate === null ? '—' : formatCalendarDate(row.firstShiftDate)}
                      {incomplete && (
                        <span className="stats__tag" data-testid="stats-incomplete">
                          {' · неполные'}
                        </span>
                      )}
                    </span>
                  </div>
                  {groupCell(
                    formatDuration(row.workingMinutes),
                    `смена ${formatDuration(row.shiftDurationMinutes)}`,
                  )}
                  {groupCell(
                    idleLabel(
                      row.idleWithQueueMinutes,
                      row.idleWithQueuePercent,
                      row.idleIncomplete,
                    ),
                    idleLabel(
                      row.idleWithoutQueueMinutes,
                      row.idleWithoutQueuePercent,
                      row.idleIncomplete,
                    ),
                  )}
                  {groupCell(
                    <strong>{row.uniqueAssembledCount}</strong>,
                    row.reassemblyCount > 0 ? (
                      <span data-testid="stats-reassembly">{row.reassemblyCount} пересб.</span>
                    ) : (
                      ''
                    ),
                  )}
                  {valueCell(row.moneyIncomplete ? 'неполно' : formatRubles(row.totalSumMinor))}
                  {valueCell(row.ordersPerHour.toFixed(1))}
                  {valueCell(row.moneyIncomplete ? '—' : (row.rublesPerHour?.toFixed(0) ?? '—'))}
                  {groupCell(
                    formatMinutes(row.avgAssemblyMinutes),
                    `мед. ${formatMinutes(row.medianAssemblyMinutes)}`,
                  )}
                  <div className="stats__cell stats__cell--end">
                    <span className={`stats__big stats__delta stats__delta--${d.direction}`}>
                      {d.text}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
