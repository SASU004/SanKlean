import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

// Apply the persisted appearance before first paint so a saved dark theme
// never flashes light. The App effect takes over afterwards; anything
// unreadable here simply falls back to the CSS defaults.
try {
  const raw = localStorage.getItem('sanklean:appearance:v1');
  const parsed = raw ? (JSON.parse(raw) as { state?: { theme?: unknown; font?: unknown } }) : null;
  const theme = parsed?.state?.theme;
  const font = parsed?.state?.font;
  const systemDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme !== 'light' && systemDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (font === 'inter' || font === 'geist' || font === 'plex' || font === 'mono' || font === 'system') {
    document.documentElement.dataset.font = font;
  }
} catch {
  // Private mode etc. — App applies defaults after mount.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
