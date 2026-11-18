import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installLogging } from './lib/log';
import './styles.css';

installLogging();
if (window.studioEx?.frameless) document.documentElement.classList.add('frameless');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
