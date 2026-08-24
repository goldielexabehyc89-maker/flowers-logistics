/**
 * Названия регионов адреса.
 *
 * МойСклад отдаёт регион ССЫЛКОЙ и без названия: на живой выборке из 1200
 * заказов регион был заполнен у 24, и ни у одного из них названия в ответе
 * не оказалось — только `meta.href`. Название лежит в справочнике и читается
 * отдельным `GET`.
 *
 * Справочник маленький и почти неизменный, а регион встречается редко,
 * поэтому названия держатся в памяти прохода: повторный заказ того же региона
 * сети не касается вовсе.
 *
 * Отказ справочника заказ не ломает. Неизвестный регион означает «названия
 * нет», и в деталях адреса он просто не показывается: придумывать название
 * по идентификатору нельзя, а терять из-за этого весь заказ — тем более.
 */

import type { MoyskladClient } from './client.js';
import { MOYSKLAD_BASE_URL } from './config.js';

/** Ссылка на регион в адресе заказа. `null` — региона нет. */
export function regionHrefOf(full: unknown): string | null {
  if (typeof full !== 'object' || full === null) {
    return null;
  }
  const region = (full as { region?: unknown }).region;
  if (typeof region !== 'object' || region === null) {
    return null;
  }
  const href = (region as { meta?: { href?: unknown } }).meta?.href;
  return typeof href === 'string' && href.trim() !== '' ? href.trim() : null;
}

export class RegionDirectory {
  private readonly names = new Map<string, string>();
  /** Ссылки, по которым справочник уже отказал: второй раз не спрашиваем. */
  private readonly failed = new Set<string>();

  constructor(private readonly client: MoyskladClient) {}

  /** Готовые названия для маппера. */
  get snapshot(): ReadonlyMap<string, string> {
    return this.names;
  }

  /**
   * Дочитывает названия для ссылок, которых ещё нет в памяти.
   *
   * Обращение к сети — только за неизвестными: страница из ста заказов одного
   * города даёт ровно один запрос, а не сто.
   */
  async resolve(hrefs: readonly string[]): Promise<void> {
    const unknown = [
      ...new Set(
        hrefs.filter((href) => href !== '' && !this.names.has(href) && !this.failed.has(href)),
      ),
    ];

    for (const href of unknown) {
      const prefix = `${MOYSKLAD_BASE_URL}/`;
      if (!href.startsWith(prefix)) {
        // Чужой адрес в ссылке — не наш справочник. Ни одного обращения.
        this.failed.add(href);
        continue;
      }

      try {
        const body = await this.client.send('GET', href.slice(MOYSKLAD_BASE_URL.length));
        const name =
          typeof body === 'object' && body !== null ? (body as { name?: unknown }).name : undefined;
        if (typeof name === 'string' && name.trim() !== '') {
          this.names.set(href, name.trim());
        } else {
          this.failed.add(href);
        }
      } catch {
        // Справочник недоступен: заказ важнее его региона.
        this.failed.add(href);
      }
    }
  }
}
