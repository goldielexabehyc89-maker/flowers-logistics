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
import {
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  StatusBadge,
  TextInput,
} from '../../ui/components';

interface Comparison {
  shiftDurationMinutes: number;
  workingMinutes: number;
  idleWithQueueMinutes: number | null;
  idleWithoutQueueMinutes: number | null;
  uniqueAssembledCount: number;
  totalSumMinor: string | null;
  ordersPerHour: number;
  rublesPerHour: number | null;
  avgAssemblyMinutes: number | null;
  medianAssemblyMinutes: number | null;
}

interface StatRow extends Comparison {
  floristId: string;
  floristName: string;
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

/** Дельта числа к предыдущему периоду: абсолют и процент. */
function delta(current: number, previous: number): string {
  const abs = current - previous;
  const sign = abs > 0 ? '+' : '';
  const pct = previous === 0 ? (current === 0 ? 0 : 100) : (abs / previous) * 100;
  const pctText = previous === 0 && current !== 0 ? '—' : `${sign}${pct.toFixed(0)}%`;
  return `${sign}${abs.toFixed(abs % 1 === 0 ? 0 : 1)} (${pctText})`;
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
        <div className="finance__table-wrap">
          <table className="finance__table" data-testid="stats-table">
            <thead>
              <tr>
                <th>Флорист</th>
                <th>Смена</th>
                <th>Работа</th>
                <th>Простой с очередью</th>
                <th>Простой без очереди</th>
                <th>Собрано</th>
                <th>Сумма</th>
                <th>Заказов/ч</th>
                <th>₽/ч</th>
                <th>Ср. сборка</th>
                <th>Медиана</th>
                <th>Δ собрано (к пред.)</th>
              </tr>
            </thead>
            <tbody>
              {stats.data.rows.map((row) => (
                <tr key={row.floristId} data-testid="stats-row" data-florist={row.floristId}>
                  <td>{row.floristName}</td>
                  <td>{formatDuration(row.shiftDurationMinutes)}</td>
                  <td>{formatDuration(row.workingMinutes)}</td>
                  <td>
                    {row.idleIncomplete ? (
                      <StatusBadge tone="warning">неполно</StatusBadge>
                    ) : (
                      `${formatDuration(row.idleWithQueueMinutes ?? 0)} · ${row.idleWithQueuePercent ?? 0}%`
                    )}
                  </td>
                  <td>
                    {row.idleIncomplete ? (
                      <StatusBadge tone="warning">неполно</StatusBadge>
                    ) : (
                      `${formatDuration(row.idleWithoutQueueMinutes ?? 0)} · ${row.idleWithoutQueuePercent ?? 0}%`
                    )}
                  </td>
                  <td>{row.uniqueAssembledCount}</td>
                  <td>
                    {row.moneyIncomplete ? (
                      <StatusBadge tone="warning">неполно</StatusBadge>
                    ) : (
                      formatRubles(row.totalSumMinor)
                    )}
                  </td>
                  <td>{row.ordersPerHour.toFixed(1)}</td>
                  <td>{row.moneyIncomplete ? '—' : (row.rublesPerHour?.toFixed(0) ?? '—')}</td>
                  <td>{formatMinutes(row.avgAssemblyMinutes)}</td>
                  <td>{formatMinutes(row.medianAssemblyMinutes)}</td>
                  <td>{delta(row.uniqueAssembledCount, row.comparison.uniqueAssembledCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
