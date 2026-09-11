import React from 'react';
import { createRoot } from 'react-dom/client';
import { AccountGate } from './AccountGate.tsx';
import { App } from './App.tsx';
import './style.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AccountGate>
      <App />
    </AccountGate>
  </React.StrictMode>,
);
