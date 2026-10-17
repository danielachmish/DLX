import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/dlx.css';
import './styles/shell.css';
import './styles/components.css';
import App from './App';
import { DialogHost, ToastStack } from './components/hosts';
import { applyTheme } from './lib/theme';

applyTheme();
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <DialogHost />
      <ToastStack />
    </BrowserRouter>
  </StrictMode>,
);
