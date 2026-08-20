/**
 * Экран сканирования поверх складского раздела.
 *
 * Открывается только по явному нажатию и живёт до конца цепочки: между шагами
 * он не закрывается, иначе кладовщик с коробкой в руках каждый раз заново
 * искал бы кнопку. Постоянная подсказка сверху отвечает на вопрос «что
 * сканировать сейчас», а строка операции — на вопрос «куда именно», чтобы
 * нельзя было сканировать непонятно во что.
 *
 * Результат каждого распознавания показывается отдельным окном: успех
 * закрывается сам, ошибка ждёт человека с кнопками «Повторить» и «Отмена».
 * Пока окно открыто, декодер и кнопки заблокированы — один QR в кадре не
 * должен дать две операции.
 *
 * Кадры остаются на устройстве: сюда приходит только распознанная строка.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/components';
import {
  CAMERA_FAILURE_TEXT,
  CameraError,
  resolveCameraAdapter,
  type CameraSession,
} from './camera';
import {
  canAccept,
  initialState,
  scanTitle,
  isFinished,
  reduce,
  stepHint,
  type ScanChain,
  type ScanEvent,
  type ScanIntent,
  type ScanState,
} from './scan-machine';

/** Сколько показывать успешное уведомление. Прочитать успевают, ждать — нет. */
export const SUCCESS_NOTICE_MS = 1400;

/**
 * То же для складского варианта с отдельным окном.
 *
 * Окно перекрывает кадр целиком, и глазу нужно чуть больше времени, чем
 * подписи под камерой: сначала найти окно, потом прочитать. Константа своя,
 * потому что у самовывоза поведение прежнее и менять его этим заданием
 * не разрешено.
 */
export const SUCCESS_WINDOW_MS = 1500;

export interface ScannerScreenProps {
  chain: ScanChain;
  /** Что именно происходит: «Приёмка», «Лист R-12» и подобное. */
  operation: string;
  /**
   * Ожидаемая ячейка, если она известна заранее.
   *
   * Попадает в заголовок: «Сканирование ячейки 8». Кладовщик не должен
   * помнить, какую именно полку у него спрашивают.
   */
  expectedCell?: string | null;
  /**
   * Выполняет намерение машины. Возвращает событие, которым машина продолжит
   * работу. Сеть живёт здесь, а не в машине и не в камере.
   */
  onIntent: (intent: ScanIntent) => Promise<ScanEvent>;
  onClose: () => void;
  /**
   * Показывать исход отдельным окном поверх кадра.
   *
   * Складской вариант. Под камерой подпись терялась: человек смотрит в кадр,
   * а результат появлялся ниже рамки, и о неудаче он узнавал, только когда
   * ничего не происходило дальше. Самовывоз остаётся на прежнем поведении,
   * поэтому это выбор вызывающего экрана, а не общее правило.
   */
  resultWindow?: boolean;
}

export function ScannerScreen({
  chain,
  operation,
  expectedCell,
  onIntent,
  onClose,
  resultWindow = false,
}: ScannerScreenProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<CameraSession | null>(null);
  const stateRef = useRef<ScanState>(initialState(chain));
  const [state, setState] = useState<ScanState>(stateRef.current);
  const [cameraError, setCameraError] = useState<string | null>(null);
  /*
   * Счётчик попыток запустить камеру.
   *
   * «Повторить» в окне отказа обязано именно перезапускать поток, а не просто
   * убирать сообщение: разрешение могли выдать в системных настройках, камеру
   * могли освободить из другого приложения. Смена счётчика перезапускает
   * эффект — другого способа начать поток заново у него нет.
   */
  const [cameraAttempt, setCameraAttempt] = useState(0);

  const apply = useCallback((event: ScanEvent): ScanIntent => {
    const { state: next, intent } = reduce(stateRef.current, event);
    stateRef.current = next;
    setState(next);
    return intent;
  }, []);

  /*
   * Свежий обработчик держится в ссылке, а не в зависимостях.
   *
   * Вызывающие экраны передают `onIntent` новой функцией на каждую отрисовку.
   * Пока он входил в зависимости, вместе с ним менялся и `dispatch`, а от него
   * зависит запуск камеры: любая перерисовка останавливала поток и открывала
   * новый. Человек видел моргание кадра, а браузер мог заново спросить
   * разрешение. Через ссылку вызывается всегда последний обработчик,
   * но личность `dispatch` больше не меняется.
   */
  const onIntentRef = useRef(onIntent);
  onIntentRef.current = onIntent;

  /** Один вход для всех событий: и камеры, и кнопок. */
  const dispatch = useCallback(
    async (event: ScanEvent): Promise<void> => {
      const intent = apply(event);
      if (intent.kind === 'none') {
        return;
      }
      const outcome = await onIntentRef.current(intent);
      apply(outcome);
    },
    [apply],
  );

  const stopCamera = useCallback((): void => {
    sessionRef.current?.stop();
    sessionRef.current = null;
  }, []);

  // Камера запускается сразу при открытии экрана — а сам экран открывается
  // только по нажатию человека, поэтому разрешение спрашивается по действию.
  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    if (video === null) {
      return;
    }

    void resolveCameraAdapter()
      .start(video, {
        onCode: (code) => void dispatch({ type: 'scanned', code }),
        onEmptyFrame: () => void dispatch({ type: 'frameEmpty' }),
      })
      .then((session) => {
        if (cancelled) {
          session.stop();
          return;
        }
        sessionRef.current = session;
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setCameraError(
          CAMERA_FAILURE_TEXT[error instanceof CameraError ? error.failure : 'FAILED'],
        );
      });

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [dispatch, stopCamera, cameraAttempt]);

  /** Повторный запуск камеры после технического отказа. */
  const retryCamera = useCallback((): void => {
    stopCamera();
    setCameraError(null);
    setCameraAttempt((attempt) => attempt + 1);
  }, [stopCamera]);

  // Успешное уведомление закрывается само. Константа проверена тестом:
  // «мигнуло и исчезло» и «висит до нажатия» одинаково плохи.
  useEffect(() => {
    if (state.notice?.kind !== 'success') {
      return;
    }
    const timer = window.setTimeout(
      () => void dispatch({ type: 'noticeExpired' }),
      resultWindow ? SUCCESS_WINDOW_MS : SUCCESS_NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state.notice, dispatch, resultWindow]);

  // Цепочка завершена: камера гаснет и экран закрывается.
  useEffect(() => {
    if (isFinished(state)) {
      stopCamera();
      onClose();
    }
  }, [state, stopCamera, onClose]);

  // Escape и системная кнопка «назад» не должны оставлять камеру включённой.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        stopCamera();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stopCamera, onClose]);

  /*
   * Что показывает окно исхода.
   *
   * Технический отказ камеры показывается тем же окном отказа, что и
   * непринятый код: для человека это одно и то же событие — «сейчас
   * отсканировать не получилось», — и разные способы сообщить об этом
   * заставляли бы разбираться, куда смотреть.
   */
  const result = state.notice;
  const resultKind = cameraError !== null ? 'error' : (result?.kind ?? 'error');

  const hint = useMemo(() => stepHint(state), [state]);
  const title = useMemo(() => scanTitle(state, expectedCell ?? null), [state, expectedCell]);
  const busy = !canAccept(state);

  const close = useCallback((): void => {
    stopCamera();
    void dispatch({ type: 'cancel' });
    onClose();
  }, [dispatch, onClose, stopCamera]);

  /*
   * Окно, а не весь экран.
   *
   * Камера во весь экран не оставляет человеку ориентира: не видно, где он
   * находится и что происходит под окном. Компактное окно с отступами
   * держит и то и другое, а рамка считывания показывает, куда наводить.
   */
  return (
    <div className="scanner-backdrop" role="presentation" onClick={close}>
      <section
        className="scanner"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="scanner__bar">
          <div>
            <strong className="scanner__title" data-testid="scan-title">
              {title}
            </strong>
            <div className="field__label">{operation}</div>
          </div>
          <button
            type="button"
            className="scanner__close"
            aria-label="Закрыть сканирование"
            data-testid="scan-close"
            onClick={close}
          >
            ✕
          </button>
        </header>

        {/*
          Кадр остаётся на месте и при отказе камеры, когда исход показывается
          окном: окно накрывает рамку, и подменять её ещё и текстом значило бы
          показать одну ошибку дважды в двух местах.
        */}
        {cameraError === null || resultWindow ? (
          <div className="scanner__frame">
            <video
              ref={videoRef}
              className="scanner__video"
              data-testid="scan-video"
              playsInline
              muted
            />
            {/* Рамка считывания: показывает, куда наводить, и ничего не решает. */}
            <span className="scanner__reticle" aria-hidden="true" />

            {/*
              Исход сканирования — отдельное окно поверх кадра.

              Оно центрировано и перекрывает рамку намеренно: человек смотрит
              в кадр, и результат обязан оказаться там, куда уже направлен
              взгляд. Успех уходит сам, отказ ждёт решения.
            */}
            {resultWindow && (result !== null || cameraError !== null) && (
              <div className="scan-result" role="alert" data-testid="scan-result">
                <div
                  className={
                    resultKind === 'success'
                      ? 'scan-result__window scan-result__window--success'
                      : 'scan-result__window scan-result__window--error'
                  }
                  /* Признак исхода один и тот же в обоих вариантах: окно и
                     подпись под камерой отличаются местом, а не смыслом. */
                  data-testid={resultKind === 'success' ? 'scan-success' : 'scan-error'}
                >
                  <span className="scan-result__icon" aria-hidden="true">
                    {resultKind === 'success' ? '✓' : '✕'}
                  </span>

                  <p className="scan-result__text" data-testid="scan-result-text">
                    {cameraError ?? result?.text}
                  </p>

                  {result?.scanned !== undefined && (
                    <p className="scan-result__line" data-testid="scan-error-scanned">
                      Распознано: <b>{result.scanned}</b>
                    </p>
                  )}
                  {result?.expected !== undefined && (
                    <p className="scan-result__line" data-testid="scan-error-expected">
                      Ожидалось: <b>{result.expected}</b>
                    </p>
                  )}

                  {resultKind === 'success' ? (
                    <p className="scan-result__line">Закроется само</p>
                  ) : (
                    <div className="scan-result__actions">
                      <Button
                        variant="primary"
                        data-testid="scan-retry"
                        onClick={() => {
                          if (cameraError !== null) {
                            retryCamera();
                            return;
                          }
                          void dispatch({ type: 'retry' });
                        }}
                      >
                        Повторить
                      </Button>
                      <Button
                        data-testid="scan-error-cancel"
                        onClick={() => {
                          stopCamera();
                          void dispatch({ type: 'cancel' });
                          onClose();
                        }}
                      >
                        Отмена
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="scanner__failure" role="alert" data-testid="scan-camera-error">
            {cameraError}
          </p>
        )}

        <p className="scanner__hint" data-testid="scan-hint">
          {hint}
        </p>

        {state.progress !== null && (
          <p className="scanner__progress" data-testid="scan-progress">
            {state.progress.done} из {state.progress.total}
          </p>
        )}

        {/* Результат читается программой чтения с экрана: ни цвет, ни звук
          не являются единственным способом узнать исход. */}
        <div aria-live="assertive" className="scanner__live">
          {!resultWindow && state.notice !== null && (
            <div
              className={`scanner__notice scanner__notice--${state.notice.kind}`}
              data-testid={state.notice.kind === 'success' ? 'scan-success' : 'scan-error'}
            >
              {state.notice.scanned !== undefined && (
                <p className="text-sm" data-testid="scan-error-scanned">
                  Распознано: {state.notice.scanned}
                </p>
              )}
              {state.notice.expected !== undefined && (
                <p className="text-sm" data-testid="scan-error-expected">
                  Ожидалось: {state.notice.expected}
                </p>
              )}
              <p>{state.notice.text}</p>
              {state.notice.kind === 'error' && (
                <div className="row">
                  <Button
                    variant="primary"
                    data-testid="scan-retry"
                    onClick={() => void dispatch({ type: 'retry' })}
                  >
                    Повторить
                  </Button>
                  <Button
                    data-testid="scan-error-cancel"
                    onClick={() => {
                      stopCamera();
                      void dispatch({ type: 'cancel' });
                      onClose();
                    }}
                  >
                    Отмена
                  </Button>
                </div>
              )}
            </div>
          )}

          {state.step === 'ROUTE_CHOICE' && state.routeChoice !== null && (
            <div className="scanner__notice" data-testid="scan-route-choice">
              <p>
                Заказ {state.orderNumber} уже входит в МЛ {state.routeChoice.routeNumber}
              </p>
              <div className="row">
                <Button
                  variant="primary"
                  data-testid="scan-route-assembly"
                  onClick={() => void dispatch({ type: 'routeChoiceAnswered', choice: 'ASSEMBLY' })}
                >
                  В сборку
                </Button>
                <Button
                  data-testid="scan-route-storage"
                  onClick={() => void dispatch({ type: 'routeChoiceAnswered', choice: 'STORAGE' })}
                >
                  Всё равно в хранение
                </Button>
                <Button data-testid="scan-route-cancel" onClick={close}>
                  Отмена
                </Button>
              </div>
            </div>
          )}

          {state.step === 'ROUTE_CELL_CONSENT' && (
            <div className="scanner__notice" data-testid="scan-consent">
              <p>
                Это маршрутная ячейка. Положить заказ сразу в маршрутный лист? Отказ вернёт к
                сканированию другой ячейки.
              </p>
              <div className="row">
                <Button
                  variant="primary"
                  data-testid="scan-consent-yes"
                  onClick={() => void dispatch({ type: 'consentAnswered', agreed: true })}
                >
                  Да, в маршрутную ячейку
                </Button>
                <Button
                  data-testid="scan-consent-no"
                  onClick={() => void dispatch({ type: 'consentAnswered', agreed: false })}
                >
                  Выбрать другую
                </Button>
              </div>
            </div>
          )}
        </div>

        {busy &&
          state.notice === null &&
          state.step !== 'ROUTE_CELL_CONSENT' &&
          state.step !== 'ROUTE_CHOICE' && (
            <p className="muted text-sm" data-testid="scan-busy">
              Отправляем…
            </p>
          )}

        {/*
          «+ Доп. ячейка» — это согласие занять листом новую полку, а не
          переключение вида. Без него свободная маршрутная ячейка отвергается
          сервером: занятая полка меняет работу соседнего листа.
        */}
        {state.step === 'CELL' &&
          state.target === 'ROUTE' &&
          state.routeChoice !== null &&
          state.routeChoice.cells.length > 0 && (
            <Button
              variant="secondary"
              className="scanner__cancel"
              data-testid="scan-add-cell"
              disabled={state.allowNewCell}
              onClick={() => void dispatch({ type: 'allowNewCell' })}
            >
              + Доп. ячейка
            </Button>
          )}

        <Button className="scanner__cancel" data-testid="scan-cancel" onClick={close}>
          Отмена
        </Button>
      </section>
    </div>
  );
}
