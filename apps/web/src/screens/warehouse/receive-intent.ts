/**
 * Сканирование приёмки: заказ → ячейка, одной атомарной парой.
 *
 * Один и тот же процесс на две точки входа — вкладку «Склад» и вкладку
 * «Ожидают приёмки». Второго пути размещения нет: обе кладут коробку тем же
 * запросом `POST /api/warehouse/placements` (а «в сборку» — тем же
 * `routes/:id/pick`, что и «Склад»). До второго скана база не меняется,
 * поэтому прерванная цепочка не оставляет «приёмки без ячейки».
 *
 * «Ожидают приёмки» отличается только одним: заказ на карточке уже выбран, и
 * отсканированный QR обязан совпасть именно с ним. Это выражено проверкой
 * `guard` на шаге разрешения заказа — сравнением устойчивого идентификатора
 * (`orderId`), а не похожей строки номера. Всё остальное — общий код.
 */

import { ApiError } from '../../lib/api-client';
import type { useAuth } from '../../auth/AuthContext';
import type { ScanEvent, ScanIntent } from '../../scan/scan-machine';
import type { ScanContext } from './warehouse-flow';

type Client = ReturnType<typeof useAuth>['client'];

/** Безопасный текст отказа: наружу только публичное сообщение сервера. */
function failureText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function conflictKind(error: unknown): string | null {
  return error instanceof ApiError ? (error.conflict?.kind ?? null) : null;
}

export interface ReceiveIntentOptions {
  client: Client;
  /** Обновление списков после успешной приёмки. */
  onPlaced: () => Promise<void>;
  /**
   * Проверка совпадения отсканированного заказа с ожидаемым.
   *
   * Возвращает событие отказа, если заказ не тот, — и цепочка остаётся на шаге
   * заказа, ничего не записав. `null` — заказ подходит, приёмка продолжается.
   * Нужна «Ожидают приёмки», где карточка задаёт конкретный заказ; у вкладки
   * «Склад» проверки нет.
   */
  guard?: (context: ScanContext) => ScanEvent | null;
}

/**
 * Собирает обработчик намерений сканера для приёмки.
 *
 * Сеть живёт здесь, а не в машине шагов и не в камере: машина решает, что
 * спросить у сервера, а этот обработчик спрашивает и возвращает событие,
 * которым машина продолжит работу.
 */
export function createReceiveIntent({
  client,
  onPlaced,
  guard,
}: ReceiveIntentOptions): (intent: ScanIntent) => Promise<ScanEvent> {
  let consentedCell: string | null = null;
  let routeNumber: string | null = null;

  return async (intent) => {
    try {
      if (intent.kind === 'resolveOrder') {
        const context = await client.get<ScanContext>(
          `/api/warehouse/scan/order?number=${encodeURIComponent(intent.code)}`,
        );

        if (guard !== undefined) {
          const rejection = guard(context);
          if (rejection !== null) {
            return rejection;
          }
        }

        if (context.route !== null) {
          routeNumber = context.route.number;
          return {
            type: 'routeChoiceRequired',
            orderNumber: context.orderNumber,
            route: {
              routeId: context.route.id,
              routeNumber: context.route.number,
              cells: context.route.routeCells,
            },
          };
        }
        routeNumber = null;
        return { type: 'orderResolved', orderNumber: context.orderNumber };
      }

      if (intent.kind === 'submitPair' && intent.target === 'ROUTE') {
        /*
         * «В сборку»: назначение полки и перенос коробки — одна транзакция.
         *
         * Раздельные шаги оставляли бы лист с занятой полкой, на которой
         * ничего не стоит, если кладовщика позвали между ними.
         */
        const result = await client.post<{
          orderNumber: string;
          cellCode: string;
          picked: number;
          total: number;
        }>(`/api/warehouse/routes/${intent.routeId ?? ''}/pick`, {
          orderNumber: intent.orderNumber,
          cellCode: intent.cellCode,
          ...(intent.allowNewCell ? { bindIfFree: true } : {}),
        });
        await onPlaced();
        return {
          type: 'succeeded',
          text: `Заказ ${result.orderNumber} перемещён в ячейку ${result.cellCode} для МЛ ${routeNumber ?? ''}`.trim(),
          progress: { done: result.picked, total: result.total },
          final: true,
        };
      }

      if (intent.kind === 'submitPair') {
        const agreed = consentedCell === intent.cellCode;
        const result = await client.post<{ orderNumber: string; cellCode: string }>(
          '/api/warehouse/placements',
          {
            orderNumber: intent.orderNumber,
            cellCode: intent.cellCode,
            ...(agreed ? { allowRouteCell: true } : {}),
          },
        );
        consentedCell = null;
        await onPlaced();
        return {
          type: 'succeeded',
          text: `Заказ ${result.orderNumber} помещён в ячейку ${result.cellCode}`,
          final: true,
        };
      }
      return { type: 'failed', text: 'Неподдерживаемый шаг сканирования.' };
    } catch (error) {
      if (
        intent.kind === 'submitPair' &&
        intent.target === 'STORAGE' &&
        conflictKind(error) === 'ROUTE_CELL_REQUIRES_CHOICE'
      ) {
        consentedCell = intent.cellCode;
        return { type: 'consentRequired', cellCode: intent.cellCode };
      }
      return { type: 'failed', text: failureText(error, 'Не удалось разместить заказ.') };
    }
  };
}
