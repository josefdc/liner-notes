// First: Zod's settings apply before any schema parses.
import './zodConfig';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { rootErrorOptions } from './rootErrors';
import './styles/index.css';

function mount() {
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
}

// The static demo answers the app's API requests in the browser, from recorded answers. Any other
// build leaves this branch and the demo's code out of its bundle.
if (import.meta.env.VITE_STATIC_DEMO === '1') {
  void import('./demo/staticApi').then(({ installStaticApi }) => {
    installStaticApi();
    mount();
  });
} else {
  mount();
}
