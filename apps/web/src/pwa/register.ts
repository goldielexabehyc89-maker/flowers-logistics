/**
 * Регистрация service worker.
 *
 * Service worker нужен только для того, чтобы оболочка открывалась без сети.
 * Никакой офлайн-очереди действий он не создаёт: без связи рабочие операции
 * честно сообщают «Нет связи».
 */

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  // Регистрация после загрузки страницы: она не должна конкурировать
  // с первой отрисовкой интерфейса.
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Отсутствие service worker не ломает приложение: оно работает как обычный сайт.
    });
  });
}
