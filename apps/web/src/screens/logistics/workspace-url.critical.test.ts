/**
 * Проверки состояния рабочего дня в адресе.
 *
 * Защищаемых свойств два. Первое: день и активный черновик переживают
 * обновление страницы и переход по прямой ссылке — иначе логист, вернувшийся
 * по ссылке, попадал бы на «сегодня» и искал бы свой черновик руками.
 * Второе: в адрес не попадают массивы выбора.
 */

import { describe, expect, it } from 'vitest';
import {
  DAY_PARAM,
  DRAFT_PARAM,
  isDayValue,
  readDay,
  readDraft,
  workspaceHref,
  writeWorkspace,
} from './workspace-url';

const TODAY = '2026-08-14';
const DRAFT = '0b8f5a1c-2d3e-4f50-9a1b-2c3d4e5f6071';

describe('день рабочего места', () => {
  it('читается из адреса и переживает обновление страницы', () => {
    expect(readDay(new URLSearchParams(`${DAY_PARAM}=2026-12-31`), TODAY)).toBe('2026-12-31');
  });

  it('несуществующая дата не подменяется соседним днём', () => {
    // `2026-02-30` прошла бы проверку формы и молча стала бы первым марта,
    // показав заказы другого дня.
    expect(isDayValue('2026-02-30')).toBe(false);
    expect(readDay(new URLSearchParams(`${DAY_PARAM}=2026-02-30`), TODAY)).toBe(TODAY);
  });

  it('високосный день принимается', () => {
    expect(isDayValue('2028-02-29')).toBe(true);
  });

  it('мусор и пустой адрес дают день по умолчанию, а не пустой экран', () => {
    expect(readDay(new URLSearchParams(`${DAY_PARAM}=вчера`), TODAY)).toBe(TODAY);
    expect(readDay(new URLSearchParams(), TODAY)).toBe(TODAY);
  });
});

describe('активный черновик', () => {
  it('читается из прежнего параметра route', () => {
    // Имя сохранено намеренно: «Сделки» уже уводят на ?route=<id>,
    // и прежние ссылки обязаны продолжать работать.
    expect(readDraft(new URLSearchParams(`${DRAFT_PARAM}=${DRAFT}`))).toBe(DRAFT);
  });

  it('не-UUID трактуется как «не выбран»', () => {
    expect(readDraft(new URLSearchParams(`${DRAFT_PARAM}=42`))).toBeNull();
    expect(readDraft(new URLSearchParams())).toBeNull();
  });

  it('снятие активного черновика убирает параметр целиком', () => {
    const next = writeWorkspace(new URLSearchParams(`${DRAFT_PARAM}=${DRAFT}`), {
      day: TODAY,
      draftId: null,
    });
    expect(next.has(DRAFT_PARAM)).toBe(false);
  });
});

describe('сборка адреса', () => {
  it('чужие параметры экрана не теряются при смене дня', () => {
    const next = writeWorkspace(new URLSearchParams('search=A-1024&date=2026-01-01'), {
      day: TODAY,
      draftId: DRAFT,
    });
    expect(next.get('search')).toBe('A-1024');
    expect(next.get(DAY_PARAM)).toBe(TODAY);
    expect(next.get(DRAFT_PARAM)).toBe(DRAFT);
  });

  it('переход на соседнюю вкладку сохраняет день', () => {
    expect(workspaceHref('/logistics/routing', { day: TODAY, draftId: null })).toBe(
      `/logistics/routing?${DAY_PARAM}=${TODAY}`,
    );
  });

  it('в адрес не попадает выбор заказов', () => {
    // Массив выбора в адресе сделал бы ссылку непередаваемой, а длину адреса —
    // ограничением рабочего процесса.
    const next = writeWorkspace(new URLSearchParams(), { day: TODAY, draftId: DRAFT });
    expect([...next.keys()].sort()).toEqual([DAY_PARAM, DRAFT_PARAM].sort());
  });
});
