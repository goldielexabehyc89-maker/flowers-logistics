/**
 * Названия операций журнала расчётов — ОДНО на весь продукт.
 *
 * Экран и выгрузки показывают одни и те же строки журнала. Пока названия жили
 * в двух местах, они расходились: файл называл любую отмену «обратной
 * корректировкой», экран — «Отмена начального долга», и найти в выгрузке
 * строку, увиденную на экране, было нельзя. Общий словарь делает расхождение
 * невозможным, а не маловероятным.
 */

export const LEDGER_KIND_LABELS: Record<string, string> = {
  CASH_RECEIVED: 'Наличные получены курьером',
  DELIVERY_FEE: 'Оплата за доставку',
  DISTANCE_FEE: 'Оплата километров за МКАД',
  ATTEMPT_FEE: 'Оплачиваемая попытка',
  CASH_HANDED_TO_LOGIST: 'Курьер сдал логисту',
  CASH_ISSUED_TO_COURIER: 'Логист выдал курьеру',
  EXPENSE_PARKING: 'Расход: парковка',
  EXPENSE_TOLL: 'Расход: платная дорога',
  EXPENSE_TRANSIT: 'Расход: общественный транспорт',
  EXPENSE_REPAIR: 'Расход: ремонт',
  EXPENSE_LOADING: 'Расход: погрузка',
  EXPENSE_OTHER: 'Дополнительный расход',
  BONUS: 'Доплата курьеру',
  ADJUSTMENT: 'Обратная корректировка',
  OPENING_DEBT: 'Начальный долг',
  CASH_PAYMENT_CORRECTION: 'Корректировка наличных: оплата в МойСклад',
  /*
   * Движения кассы логиста. Тот же словарь: «История» показывает их рядом с
   * операциями курьера, и две системы названий в одном списке читались бы как
   * разные сущности.
   */
  DESK_RECEIVED_FROM_COURIER: 'Касса: получено от курьера',
  DESK_ISSUED_TO_COURIER: 'Касса: выдано курьеру',
  DESK_TAKEN_FROM_COMPANY: 'Касса: взято из компании',
  DESK_HANDED_TO_COMPANY: 'Касса: сдано в компанию',
  DESK_ADJUSTMENT: 'Касса: обратная корректировка',
};

/** Название вида операции. Неизвестный вид возвращается как есть. */
export function ledgerKindLabel(kind: string): string {
  return LEDGER_KIND_LABELS[kind] ?? kind;
}

/**
 * Название СТРОКИ журнала.
 *
 * У обратной записи собственный вид всегда `ADJUSTMENT`, и без вида отменяемой
 * операции строка называлась бы одинаково для отмены долга, передачи и
 * расхода. Поэтому отмена называется по тому, что она отменяет, а перенос дня
 * учёта — по тому, что переносит, и по стороне: из какого дня учёт ушёл и в
 * какой пришёл.
 */
export function ledgerEntryTitle(entry: {
  kind: string;
  reversesKind?: string | null;
  relocatesKind?: string | null;
  relocationSide?: string | null;
}): string {
  if (entry.kind !== 'ADJUSTMENT') {
    return ledgerKindLabel(entry.kind);
  }
  const reversed = entry.reversesKind ?? null;
  if (reversed !== null) {
    return `Отмена: ${ledgerKindLabel(reversed)}`;
  }
  const relocated = entry.relocatesKind ?? null;
  if (relocated !== null) {
    const side = entry.relocationSide === 'IN' ? 'в день' : 'из дня';
    return `Перенос учёта ${side}: ${ledgerKindLabel(relocated)}`;
  }
  return ledgerKindLabel('ADJUSTMENT');
}
