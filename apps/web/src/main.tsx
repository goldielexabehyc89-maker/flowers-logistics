import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import { registerServiceWorker } from './pwa/register';
import { ToastProvider } from './ui/ToastProvider';
import './styles/tokens.css';
import './styles/base.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('Не найден корневой элемент #root');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Данные обновляются явными инвалидациями после операций.
      // Realtime появится в ветке 1.4 и будет инвалидировать те же ключи.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

registerServiceWorker();
