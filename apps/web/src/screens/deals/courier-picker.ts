/**
 * Выбор курьера из существующих сотрудников.
 *
 * Правило одно и оно доменное: выбирается СУЩЕСТВУЮЩИЙ пользователь роли
 * курьера. Произвольная строка нового сотрудника не создаёт — иначе логист
 * в спешке завёл бы человека без телефона, PIN и проверки роли, и его пришлось
 * бы искать по всей базе.
 *
 * Поиск идёт и по имени, и по телефону: логист чаще помнит номер, чем полное
 * написание фамилии. Телефон показывается только тому, кто и так имеет к нему
 * доступ в разделе сотрудников; в realtime, журналы и отчёты он не уходит.
 */

export interface CourierOption {
  id: string;
  fullName: string;
  phone: string | null;
}

/** Только цифры: `+7 (999) 000-00-01` и `79990000001` — один и тот же номер. */
function digitsOf(value: string): string {
  return value.replace(/\D+/gu, '');
}

export function matchesCourier(option: CourierOption, query: string): boolean {
  const trimmed = query.trim();
  if (trimmed === '') {
    return true;
  }
  if (option.fullName.toLocaleLowerCase('ru').includes(trimmed.toLocaleLowerCase('ru'))) {
    return true;
  }
  const digits = digitsOf(trimmed);
  return digits !== '' && option.phone !== null && digitsOf(option.phone).includes(digits);
}

/** Что показывать в списке. Пустой запрос показывает всех: список короткий. */
export function filterCouriers(
  options: readonly CourierOption[],
  query: string,
): readonly CourierOption[] {
  return options.filter((option) => matchesCourier(option, query));
}

/** Подпись выбранного курьера. `null` — курьер не назначен, и это нормально. */
export function courierLabel(option: CourierOption | null): string {
  if (option === null) {
    return 'Курьер не назначен';
  }
  return option.phone === null ? option.fullName : `${option.fullName} · ${option.phone}`;
}

/**
 * Что уходит на сервер.
 *
 * Набранная строка сама по себе курьером не является: пока человек не выбрал
 * существующего сотрудника, назначения нет.
 */
export function courierIdFor(selected: CourierOption | null): string | null {
  return selected === null ? null : selected.id;
}
