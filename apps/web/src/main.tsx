// First: Zod's settings apply before any schema parses.
import './zodConfig';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { rootErrorOptions } from './rootErrors';
import './styles/index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}

// Errors are logged by name only: their messages can carry the page's data (rootErrors.ts).
const root = ReactDOM.createRoot(rootElement, rootErrorOptions());
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
