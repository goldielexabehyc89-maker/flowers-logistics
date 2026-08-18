/**
 * Настройки планирования: смена, время обслуживания и склады.
 *
 * Раздел доступен только администратору — как и весь экран настроек.
 *
 * Смена обязательна и умолчания не имеет: пока она не сохранена, планирование
 * честно отказывает. Раньше задать её можно было только запросом к API, то есть
 * штатного способа настроить обязательное условие не существовало.
 *
 * Каждая форма несёт ожидаемую версию: настройки и склады версионируются,
 * и слепая перезапись чужого изменения здесь так же недопустима, как в маршруте.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  ErrorState,
  Field,
  LoadingState,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import {
  activePoint,
  depotError,
  depotSuggestHint,
  EMPTY_DEPOT_DRAFT,
  formatTimeOfDay,
  parseTimeOfDay,
  serviceTimeError,
  shiftError,
  type DepotDraft,
} from './planning-settings';
import {
  acceptSuggestion,
  EMPTY_SUGGEST_BOX,
  isSuggestListOpen,
  isUsablePoint,
  shouldRequestSuggestions,
  suggestionsUrl,
  typeInSuggestBox,
  type SuggestBox,
  type SuggestResponse,
} from '../logistics/address-suggestions';
import { AddressSuggestField } from '../../ui/AddressSuggestField';

/** Микроградусы в градусы: та же единица хранения, что у заказов и складов. */
const MICRO = 1_000_000;

interface PlanningSettingsResponse {
  /** Ручная отгрузка без складского сканирования. Меняет только администратор. */
  manualIssue: { value: { enabled: boolean }; version: number };
  shift: { value: { startMinute: number; endMinute: number } | null; version: number };
  serviceTime: {
    value: { carMinutes: number; footMinutes: number };
    version: number;
    isDefault: boolean;
  };
}

interface DepotView {
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  isActive: boolean;
  isDefault: boolean;
  version: number;
}

export function PlanningSettings(): React.JSX.Element {
  const { client, user } = useAuth();
  // Настройку меняет только администратор — ровно как решает сервер.
  // Логист её видит: иначе кнопка отгрузки появлялась бы и исчезала без причины.
  const isAdmin = (user?.roles ?? []).includes('ADMIN');
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const settings = useQuery({
    queryKey: ['planning-settings'],
    queryFn: () => client.get<PlanningSettingsResponse>('/api/settings/planning'),
  });

  const depots = useQuery({
    queryKey: ['depots'],
    queryFn: () => client.get<{ items: DepotView[] }>('/api/depots'),
  });

  const [shift, setShift] = useState({ start: '', end: '' });
  const [service, setService] = useState({ car: '', foot: '' });
  const [depot, setDepot] = useState<DepotDraft>(EMPTY_DEPOT_DRAFT);

  // Поля заполняются сохранённым значением ровно один раз на загрузку: иначе
  // фоновое обновление затирало бы то, что человек уже набрал.
  useEffect(() => {
    const value = settings.data;
    if (value === undefined) {
      return;
    }
    setShift({
      start: value.shift.value === null ? '' : formatTimeOfDay(value.shift.value.startMinute),
      end: value.shift.value === null ? '' : formatTimeOfDay(value.shift.value.endMinute),
    });
    setService({
      car: String(value.serviceTime.value.carMinutes),
      foot: String(value.serviceTime.value.footMinutes),
    });
  }, [settings.data]);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['planning-settings'] });
    await queryClient.invalidateQueries({ queryKey: ['depots'] });
    // Вкладка маршрутных листов питается той же настройкой: без этого кнопка
    // «Отгрузить» меняла бы состояние только после перезагрузки страницы.
    await queryClient.invalidateQueries({ queryKey: ['route-sheets'] });
  };

  /**
   * Переключение ручной отгрузки.
   *
   * Значение уходит вместе с ожидаемой версией: настройка версионируется,
   * и слепая перезапись чужого переключения здесь так же недопустима, как
   * в маршруте. После сохранения список настроек и вкладка маршрутных листов
   * перечитываются — кнопка «Отгрузить» обязана появиться или исчезнуть сразу.
   */
  const saveManualIssue = useMutation({
    mutationFn: (enabled: boolean) =>
      client.put('/api/settings/planning/manual-issue', {
        value: { enabled },
        expectedVersion: settings.data?.manualIssue.version ?? 0,
      }),
    onSuccess: async (_result, enabled) => {
      await invalidate();
      showToast(enabled ? 'Ручная отгрузка разрешена' : 'Ручная отгрузка запрещена', 'success');
    },
    onError: (error: unknown) => showToast(errorText(error), 'error'),
  });

  const saveShift = useMutation({
    mutationFn: () =>
      client.put('/api/settings/planning/shift', {
        value: {
          startMinute: parseTimeOfDay(shift.start) ?? 0,
          endMinute: parseTimeOfDay(shift.end) ?? 0,
        },
        expectedVersion: settings.data?.shift.version ?? 0,
      }),
    onSuccess: async () => {
      await invalidate();
      showToast('Смена сохранена', 'success');
    },
    onError: (error: unknown) => showToast(errorText(error), 'error'),
  });

  const saveService = useMutation({
    mutationFn: () =>
      client.put('/api/settings/planning/service-time', {
        value: { carMinutes: Number(service.car), footMinutes: Number(service.foot) },
        expectedVersion: settings.data?.serviceTime.version ?? 0,
      }),
    onSuccess: async () => {
      await invalidate();
      showToast('Время обслуживания сохранено', 'success');
    },
    onError: (error: unknown) => showToast(errorText(error), 'error'),
  });

  /**
   * Подсказки адреса — тот же серверный контракт, что и в правке адреса заказа.
   *
   * Второй интеграции не заводится: ключ, ограничения и разбор ответа живут
   * на сервере в одном месте.
   */
  /*
   * Список закрывается выбором, а не уходом фокуса.
   *
   * Прежде выбранный адрес попадал обратно в ключ запроса, и подсказки тут же
   * открывались снова на только что принятом значении.
   */
  const [suggestBox, setSuggestBox] = useState<SuggestBox>(EMPTY_SUGGEST_BOX);

  const suggestions = useQuery({
    queryKey: ['address-suggestions', suggestBox.text],
    queryFn: () => client.get<SuggestResponse>(suggestionsUrl(suggestBox.text)),
    enabled: shouldRequestSuggestions(suggestBox),
  });

  const suggestionsAvailable = suggestions.data?.available ?? true;
  const suggestListOpen = isSuggestListOpen(
    suggestBox,
    (suggestions.data?.suggestions.length ?? 0) > 0,
  );
  const chosenPoint = activePoint(depot);

  const createDepot = useMutation({
    mutationFn: () =>
      client.post('/api/depots', {
        name: depot.name.trim(),
        address: depot.address.trim(),
        // Точка уходит только вместе с выбранной подсказкой.
        point: chosenPoint,
      }),
    onSuccess: async () => {
      setDepot(EMPTY_DEPOT_DRAFT);
      setSuggestBox(EMPTY_SUGGEST_BOX);
      await invalidate();
      showToast('Склад создан', 'success');
    },
    onError: (error: unknown) => showToast(errorText(error), 'error'),
  });

  const makeDefault = useMutation({
    mutationFn: (target: DepotView) => {
      const current = depots.data?.items.find((item) => item.isDefault) ?? null;
      return client.put(`/api/depots/${target.id}/default`, {
        expectedVersion: target.version,
        // Прежний склад называется вместе с версией: номера версий разных
        // строк независимы и совпадают случайно.
        expectedCurrentDefaultId: current?.id ?? null,
        expectedCurrentDefaultVersion: current?.version ?? null,
      });
    },
    onSuccess: async () => {
      await invalidate();
      showToast('Склад по умолчанию изменён', 'success');
    },
    onError: (error: unknown) => showToast(errorText(error), 'error'),
  });

  const setActive = useMutation({
    mutationFn: (input: { target: DepotView; isActive: boolean }) =>
      client.put(`/api/depots/${input.target.id}/active`, {
        isActive: input.isActive,
        expectedVersion: input.target.version,
      }),
    onSuccess: async () => {
      await invalidate();
      showToast('Состояние склада изменено', 'success');
    },
    onError: (error: unknown) => showToast(errorText(error), 'error'),
  });

  const shiftProblem = shiftError(shift);
  const serviceProblem = serviceTimeError(service.car, service.foot);
  const depotProblem = depotError(depot);
  const shiftMissing = settings.data?.shift.value === null;

  return (
    <section className="card stack" data-testid="planning-settings">
      <div>
        <h2>Планирование маршрутов</h2>
        <p className="muted text-sm">
          Смена обязательна: пока она не задана, автоматическое планирование недоступно. Время
          обслуживания считается на один заказ, а не на адрес.
        </p>
      </div>

      {settings.isPending || depots.isPending ? <LoadingState /> : null}
      {settings.isError ? <ErrorState onRetry={() => void settings.refetch()} /> : null}

      {settings.data === undefined ? null : (
        <>
          <div className="stack" data-testid="manual-issue-form">
            <h3>Ручная отгрузка</h3>
            <label className="toggle">
              <input
                type="checkbox"
                data-testid="manual-issue-toggle"
                checked={settings.data.manualIssue.value.enabled}
                disabled={!isAdmin || saveManualIssue.isPending}
                onChange={(event) => saveManualIssue.mutate(event.target.checked)}
              />
              Разрешить логисту отгружать маршрутные листы без сканирования
            </label>
            <p className="muted text-sm">
              Отгрузка без складского сканирования. Используйте, только если заказы фактически
              переданы курьеру.
            </p>
            {isAdmin ? null : (
              <p className="muted text-sm" data-testid="manual-issue-readonly">
                Изменяет только администратор.
              </p>
            )}
          </div>

          <form
            className="stack"
            data-testid="shift-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (shiftProblem === null) {
                saveShift.mutate();
              }
            }}
          >
            <h3>
              Общая смена{' '}
              {shiftMissing ? <StatusBadge tone="warning">не настроена</StatusBadge> : null}
            </h3>

            <Field label="Начало смены" error={shiftProblem ?? undefined}>
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  data-testid="shift-start"
                  placeholder="09:00"
                  value={shift.start}
                  onChange={(event) =>
                    setShift((current) => ({ ...current, start: event.target.value }))
                  }
                />
              )}
            </Field>

            <Field label="Окончание смены">
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  data-testid="shift-end"
                  placeholder="21:00"
                  value={shift.end}
                  onChange={(event) =>
                    setShift((current) => ({ ...current, end: event.target.value }))
                  }
                />
              )}
            </Field>

            <div>
              <Button
                type="submit"
                variant="primary"
                data-testid="shift-save"
                disabled={shiftProblem !== null}
                loading={saveShift.isPending}
              >
                Сохранить смену
              </Button>
            </div>
          </form>

          <form
            className="stack"
            data-testid="service-time-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (serviceProblem === null) {
                saveService.mutate();
              }
            }}
          >
            <h3>
              Время обслуживания заказа{' '}
              {settings.data.serviceTime.isDefault ? (
                <StatusBadge tone="info">значение по умолчанию</StatusBadge>
              ) : null}
            </h3>

            <Field label="Автомобиль, минут на заказ" error={serviceProblem ?? undefined}>
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  data-testid="service-car"
                  type="number"
                  min={0}
                  max={120}
                  value={service.car}
                  onChange={(event) =>
                    setService((current) => ({ ...current, car: event.target.value }))
                  }
                />
              )}
            </Field>

            <Field label="Пешком, минут на заказ">
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  data-testid="service-foot"
                  type="number"
                  min={0}
                  max={120}
                  value={service.foot}
                  onChange={(event) =>
                    setService((current) => ({ ...current, foot: event.target.value }))
                  }
                />
              )}
            </Field>

            <div>
              <Button
                type="submit"
                variant="primary"
                data-testid="service-save"
                disabled={serviceProblem !== null}
                loading={saveService.isPending}
              >
                Сохранить время обслуживания
              </Button>
            </div>
          </form>
        </>
      )}

      <div className="stack" data-testid="depots-block">
        <h3>Склады</h3>
        <p className="muted text-sm">
          Склад — точка отсчёта маршрутов. Удалить его нельзя: на него ссылаются посчитанные планы,
          — можно только выключить. Первый созданный склад становится складом по умолчанию.
        </p>

        {depots.data === undefined ? null : (
          <ul className="stack text-sm" data-testid="depot-list">
            {depots.data.items.map((item) => (
              <li key={item.id} data-testid="depot-item">
                <strong>{item.name}</strong> — {item.address}{' '}
                {item.isDefault ? <StatusBadge tone="success">по умолчанию</StatusBadge> : null}{' '}
                {item.isActive ? null : <StatusBadge tone="warning">выключен</StatusBadge>}{' '}
                {item.isDefault ? null : (
                  <Button
                    disabled={!item.isActive || makeDefault.isPending}
                    onClick={() => makeDefault.mutate(item)}
                  >
                    Сделать складом по умолчанию
                  </Button>
                )}{' '}
                {item.isDefault ? null : (
                  <Button
                    disabled={setActive.isPending}
                    onClick={() => setActive.mutate({ target: item, isActive: !item.isActive })}
                  >
                    {item.isActive ? 'Выключить' : 'Включить'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <form
          className="stack"
          data-testid="depot-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (depotProblem === null) {
              createDepot.mutate();
            }
          }}
        >
          <Field label="Название" error={depotProblem ?? undefined}>
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                data-testid="depot-name"
                value={depot.name}
                onChange={(event) =>
                  setDepot((current) => ({ ...current, name: event.target.value }))
                }
              />
            )}
          </Field>

          {/*
            Адрес выбирается из серверных подсказок.

            Ключ DaData остаётся на сервере: браузер обращается только к нашему
            API. Ручных полей широты и долготы здесь нет намеренно — набранные
            руками координаты ничем не связаны с адресом, и именно так склад
            оказывался не на карте, а расчёт отказывал без внятной причины.
          */}
          {/*
            Тот же компонент, что и в правке адреса заказа: поведение списка
            обязано совпадать везде, где адрес подбирают подсказкой.
          */}
          <AddressSuggestField
            label="Адрес"
            hint={depotSuggestHint(suggestionsAvailable)}
            value={depot.address}
            inputTestId="depot-address"
            listTestId="depot-suggestions"
            suggestions={suggestions.data?.suggestions ?? []}
            open={suggestListOpen}
            onChange={(text) => {
              // Правка текста немедленно снимает прежнюю точку: она
              // относилась к другому адресу.
              setDepot((current) => ({ ...current, address: text }));
              setSuggestBox((current) => typeInSuggestBox(current, text));
            }}
            onPick={(item) => {
              const latMicro = item.latMicro;
              const lonMicro = item.lonMicro;
              /*
               * Складу годится только подсказка с домом и координатами.
               *
               * Улица без дома отправила бы курьеров от середины улицы,
               * а расчёт выдал бы это за настоящее время в пути. Текст
               * принимается, точка — нет.
               */
              const usable = isUsablePoint(item) && latMicro !== null && lonMicro !== null;
              setDepot((current) => ({
                ...current,
                address: item.value,
                point: usable
                  ? { value: item.value, lat: latMicro / MICRO, lon: lonMicro / MICRO }
                  : null,
              }));
              setSuggestBox(acceptSuggestion(item.value));
            }}
          />

          {chosenPoint !== null && (
            <p className="muted text-sm" data-testid="depot-point">
              Точка определена: {chosenPoint.lat.toFixed(6)}, {chosenPoint.lon.toFixed(6)}
            </p>
          )}

          <div>
            <Button
              type="submit"
              variant="primary"
              data-testid="depot-save"
              disabled={depotProblem !== null}
              loading={createDepot.isPending}
            >
              Создать склад
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Не удалось сохранить настройку';
}
