-- Отмена отгрузки маршрутного листа.
--
-- Логист отгрузил лист и почти сразу увидел ошибку: не тот курьер, не тот
-- состав, не тот день. Вернуть лист в неотгруженное состояние было нельзя —
-- перечень разрешённых переходов такой пары не содержал, и единственным
-- выходом оставалась отмена всего маршрута с потерей состава.
--
-- Добавляются РОВНО две пары и ничего больше:
--
--   ACTIVE    → CONFIRMED  — отмена обычной отгрузки;
--   COMPLETED → CONFIRMED  — «Отменить все» административной коррекцией,
--                            когда доставленные заказы возвращаются в работу.
--
-- Новых состояний и значений перечислений не появляется, данные не
-- переписываются. Прежние запрещённые переходы остаются запрещёнными:
-- ACTIVE → DRAFT, DRAFT → COMPLETED, CANCELLED → что угодно и прочие пары
-- по-прежнему отвергаются базой.
--
-- Старый клиент против расширенной схемы работает без изменений: он таких
-- переходов не пишет, а ослабленное ограничение ему ничем не мешает.
-- Возврат приложения к прежней версии схему не ломает.
--
-- Сам обратный переход остаётся доменной операцией: роль, обязательная
-- причина там, где она предусмотрена, проверка версии, атомарность, аудит
-- до/после и realtime живут в коде, а не в этом ограничении.
ALTER TABLE "RouteStateTransition" DROP CONSTRAINT "RouteStateTransition_allowed";

ALTER TABLE "RouteStateTransition"
  ADD CONSTRAINT "RouteStateTransition_allowed" CHECK (
    ("fromState"::text = 'DRAFT' AND "toState"::text = 'CONFIRMED')
    OR ("fromState"::text = 'CONFIRMED' AND "toState"::text = 'DRAFT')
    OR ("fromState"::text = 'DRAFT' AND "toState"::text = 'CANCELLED')
    OR ("fromState"::text = 'CONFIRMED' AND "toState"::text = 'CANCELLED')
    OR ("fromState"::text = 'CONFIRMED' AND "toState"::text = 'ACTIVE')
    OR ("fromState"::text = 'ACTIVE' AND "toState"::text = 'COMPLETED')
    OR ("fromState"::text = 'COMPLETED' AND "toState"::text = 'ACTIVE')
    OR ("fromState"::text = 'ACTIVE' AND "toState"::text = 'CONFIRMED')
    OR ("fromState"::text = 'COMPLETED' AND "toState"::text = 'CONFIRMED')
  );
