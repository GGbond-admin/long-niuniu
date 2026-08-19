import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { tg, waitForTelegramWebApp } from './telegram';
import './styles.css';
import './ui-v2.css';

function mount() {
  const app = tg();
  try {
    app?.ready();
    app?.expand();
  } catch {
    // 老客户端没有 expand/ready 时仍继续挂载页面
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>,
  );
}

if (tg()) mount();
else void waitForTelegramWebApp().then(mount);
