/**
 * Проверки собственной аренды на одну операцию.
 *
 * Защищаемое свойство одно: операция освобождает ТОЛЬКО ту аренду, которую
 * взяла сама. Нарушение незаметно на экране и разрушительно в работе — снятая
 * из-под открытой карточки блокировка отдаёт черновик другому редактору
 * посреди правки.
 */

import { describe, expect, it } from 'vitest';
import { withRouteLease, type LeaseScopeDeps } from './lease-scope';

const ROUTE = 'route-1';

function recorder(acquireResult: { granted: boolean } | Error): {
  deps: LeaseScopeDeps;
  released: string[];
  acquired: string[];
} {
  const released: string[] = [];
  const acquired: string[] = [];
  return {
    released,
    acquired,
    deps: {
      acquire: async (routeId) => {
        acquired.push(routeId);
        if (acquireResult instanceof Error) {
          throw acquireResult;
        }
        return acquireResult;
      },
      release: async (routeId) => {
        released.push(routeId);
      },
    },
  };
}

describe('операция под собственной арендой', () => {
  it('взятую аренду освобождает', async () => {
    const { deps, released } = recorder({ granted: true });

    const result = await withRouteLease(deps, ROUTE, async () => 'готово');

    expect(result).toBe('готово');
    expect(released).toEqual([ROUTE]);
  });

  it('ранее существовавшую аренду НЕ освобождает', async () => {
    // `granted: false` — аренда уже принадлежала этой вкладке, её держит
    // открытая карточка. Снять её значит отдать черновик посреди правки.
    const { deps, released } = recorder({ granted: false });

    await withRouteLease(deps, ROUTE, async () => undefined);

    expect(released).toEqual([]);
  });

  it('после отказа операции взятая аренда всё равно освобождается', async () => {
    const { deps, released } = recorder({ granted: true });

    await expect(
      withRouteLease(deps, ROUTE, async () => {
        throw new Error('конфликт версий');
      }),
    ).rejects.toThrow('конфликт версий');

    expect(released).toEqual([ROUTE]);
  });

  it('после отказа операции чужая аренда не снимается', async () => {
    const { deps, released } = recorder({ granted: false });

    await expect(
      withRouteLease(deps, ROUTE, async () => {
        throw new Error('конфликт версий');
      }),
    ).rejects.toThrow('конфликт версий');

    expect(released).toEqual([]);
  });

  it('отказ захвата пробрасывается и ничего не освобождает', async () => {
    // Занятый чужим редактором маршрут — это ответ, а не сбой операции:
    // подменять его собственным текстом значило бы потерять причину.
    const { deps, released } = recorder(new Error('EDIT_LOCK_HELD_BY_OTHER'));
    let ran = false;

    await expect(
      withRouteLease(deps, ROUTE, async () => {
        ran = true;
      }),
    ).rejects.toThrow('EDIT_LOCK_HELD_BY_OTHER');

    expect(ran).toBe(false);
    expect(released).toEqual([]);
  });

  it('отказ освобождения не превращает успешную операцию в ошибку', async () => {
    // Данные уже изменены, а забытую аренду снимет истечение.
    const deps: LeaseScopeDeps = {
      acquire: async () => ({ granted: true }),
      release: async () => {
        throw new Error('сеть недоступна');
      },
    };

    await expect(withRouteLease(deps, ROUTE, async () => 'готово')).resolves.toBe('готово');
  });
});
