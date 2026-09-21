import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { routes } from './routes';

async function enableMocks() {
  // Dead code in production builds: msw never ships in the bundle.
  if (!import.meta.env.DEV || import.meta.env.VITE_MOCKS !== '1') return;
  const { worker } = await import('./mocks/browser');
  await worker.start({ onUnhandledRequest: 'bypass' });
}

void enableMocks().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RouterProvider router={createBrowserRouter(routes)} />
    </StrictMode>,
  );
});
