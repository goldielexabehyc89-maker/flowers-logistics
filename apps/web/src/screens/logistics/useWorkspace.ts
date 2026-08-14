/**
 * Рабочий день и активный черновик, общие для «Сделок» и «Маршрутизации».
 *
 * Хук ничего не решает сам: разбор и сборка адреса живут в `workspace-url.ts`
 * и проверяются без браузера. Здесь только связывание с адресной строкой.
 *
 * Запись идёт с `replace`, а не `push`: смена дня и раскрытие черновика — это
 * не шаги навигации. Иначе кнопка «назад» уводила бы логиста по истории
 * собственных кликов вместо возврата на предыдущий экран.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { moscowToday } from '@fl/shared';
import { readDay, readDraft, writeWorkspace } from './workspace-url';

export interface Workspace {
  /** Выбранный день. Никогда не пуст: мусор в адресе даёт сегодняшний день. */
  day: string;
  /** Раскрытый черновик. Одновременно он может быть только один. */
  draftId: string | null;
  setDay: (day: string) => void;
  setDraftId: (draftId: string | null) => void;
}

export function useWorkspace(): Workspace {
  const [params, setParams] = useSearchParams();

  const day = readDay(params, moscowToday());
  const draftId = readDraft(params);

  const update = useCallback(
    (next: { day?: string; draftId?: string | null }): void => {
      setParams(
        (current) =>
          writeWorkspace(current, {
            day: next.day ?? readDay(current, moscowToday()),
            draftId: next.draftId === undefined ? readDraft(current) : next.draftId,
          }),
        { replace: true },
      );
    },
    [setParams],
  );

  return useMemo(
    () => ({
      day,
      draftId,
      // Смена дня снимает активный черновик: он принадлежит другому дню,
      // и оставить его раскрытым значило бы показать состав не того дня.
      setDay: (value: string) => update({ day: value, draftId: null }),
      setDraftId: (value: string | null) => update({ draftId: value }),
    }),
    [day, draftId, update],
  );
}
