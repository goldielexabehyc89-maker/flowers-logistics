/**
 * Камера и распознавание QR в браузере.
 *
 * Кадры не покидают устройство: они рисуются в скрытый canvas, распознаются
 * локальной библиотекой и немедленно перезаписываются следующим кадром.
 * Ни изображение, ни распознанное значение не уходят в сеть, кэш запросов,
 * журнал, аудит и realtime. Сервер получает только строку кода — ровно то же,
 * что вводит человек руками.
 *
 * Реализация спрятана за интерфейсом намеренно. Проверять камеру десятками
 * таймерных прогонов ненадёжно: настоящее устройство в CI отсутствует, а
 * поведение зависит от разрешений и железа. Поэтому решение принимает машина
 * шагов, а сюда подставляется детерминированный двойник.
 */

import jsQR from 'jsqr';

/** Что адаптер сообщает подписчику. */
export interface CameraEvents {
  /** Распознан код. */
  onCode: (code: string) => void;
  /** В кадре ничего нет — прежний код разрешено принять снова. */
  onEmptyFrame: () => void;
}

export interface CameraSession {
  /** Останавливает дорожки и освобождает устройство. Идемпотентно. */
  stop: () => void;
}

export interface CameraAdapter {
  /**
   * Запускает камеру. Вызывается ТОЛЬКО из обработчика явного нажатия:
   * браузер обязан спросить разрешение по действию человека, а не при
   * открытии раздела.
   */
  start: (video: HTMLVideoElement, events: CameraEvents) => Promise<CameraSession>;
}

/** Безопасная причина отказа: текст исключения браузера наружу не идёт. */
export type CameraFailure = 'DENIED' | 'NO_DEVICE' | 'INSECURE' | 'UNAVAILABLE' | 'FAILED';

export class CameraError extends Error {
  readonly failure: CameraFailure;

  constructor(failure: CameraFailure) {
    super(failure);
    this.name = 'CameraError';
    this.failure = failure;
  }
}

/** Человеческое объяснение отказа. Ни device label, ни текста исключения. */
export const CAMERA_FAILURE_TEXT: Record<CameraFailure, string> = {
  DENIED: 'Доступ к камере запрещён. Отсканируйте аппаратным сканером или введите код вручную.',
  NO_DEVICE: 'Камера не найдена. Отсканируйте аппаратным сканером или введите код вручную.',
  INSECURE: 'Камера доступна только по защищённому соединению. Используйте сканер или ручной ввод.',
  UNAVAILABLE: 'Браузер не поддерживает камеру. Используйте сканер или ручной ввод.',
  FAILED: 'Не удалось включить камеру. Используйте сканер или ручной ввод.',
};

/** Как часто разбирать кадры. Чаще — грелка для телефона, а не польза. */
export const DECODE_INTERVAL_MS = 200;
/** Предел стороны кадра при распознавании: больше не помогает, но тормозит. */
export const MAX_DECODE_SIDE = 640;

function failureOf(error: unknown): CameraFailure {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'DENIED';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'NO_DEVICE';
  }
  return 'FAILED';
}

/**
 * Настоящая камера: `getUserMedia` + локальное распознавание.
 *
 * Задняя камера предпочтительна, но именно предпочтительна: `ideal` вместо
 * `exact` оставляет работать ноутбук с единственной фронтальной камерой,
 * тогда как `exact` отказал бы совсем.
 */
export function createBrowserCamera(): CameraAdapter {
  return {
    async start(video, events) {
      if (typeof window === 'undefined' || !window.isSecureContext) {
        throw new CameraError('INSECURE');
      }
      const media = navigator.mediaDevices;
      if (media === undefined || typeof media.getUserMedia !== 'function') {
        throw new CameraError('UNAVAILABLE');
      }

      let stream: MediaStream;
      try {
        stream = await media.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch (error) {
        throw new CameraError(failureOf(error));
      }

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });

      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      video.muted = true;
      try {
        await video.play();
      } catch {
        // Автовоспроизведение может быть отклонено: кадры всё равно приходят,
        // а падать здесь означало бы потерять уже выданное разрешение.
      }

      let stopped = false;
      const timer = window.setInterval(() => {
        if (stopped || context === null) {
          return;
        }
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width === 0 || height === 0) {
          return;
        }

        const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(width, height));
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = context.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(frame.data, frame.width, frame.height, {
          inversionAttempts: 'dontInvert',
        });

        if (found === null || found.data === '') {
          events.onEmptyFrame();
          return;
        }
        events.onCode(found.data);
      }, DECODE_INTERVAL_MS);

      return {
        stop() {
          if (stopped) {
            return;
          }
          stopped = true;
          window.clearInterval(timer);
          for (const track of stream.getTracks()) {
            track.stop();
          }
          // Ссылку на поток и пиксели держать незачем: и то и другое —
          // изображение рабочего места.
          video.srcObject = null;
          canvas.width = 0;
          canvas.height = 0;
        },
      };
    },
  };
}

declare global {
  interface Window {
    /**
     * Точка подмены камеры для браузерной проверки.
     *
     * Настоящего устройства и разрешения в CI нет, а проводку «кнопка →
     * камера → шаг → сервер» доказать нужно. Подмена возможна только тем,
     * кто уже выполняет скрипты на странице, поэтому прав она не расширяет.
     */
    __flCameraAdapter?: CameraAdapter;
  }
}

/** Настоящая камера либо подставленный двойник браузерной проверки. */
export function resolveCameraAdapter(): CameraAdapter {
  if (typeof window !== 'undefined' && window.__flCameraAdapter !== undefined) {
    return window.__flCameraAdapter;
  }
  return createBrowserCamera();
}
