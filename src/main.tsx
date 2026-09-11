import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';

// Apply the persisted appearance before first paint so a saved dark theme
// never flashes light. The App effect takes over afterwards; anything
// unreadable here simply falls back to the CSS defaults.
try {
  const raw = localStorage.getItem('sanklean:appearance:v1');
  const parsed = raw ? (JSON.parse(raw) as { state?: { theme?: unknown; font?: unknown } }) : null;
  const theme = parsed?.state?.theme;
  const rawFont = parsed?.state?.font;
  // Legacy v1 values migrate here for pre-paint too ('geist' -> 'grotesk',
  // 'system' -> 'inter'); the zustand migrate() canonicalizes post-mount.
  const font =
    rawFont === 'geist' ? 'grotesk' : rawFont === 'system' ? 'inter' : rawFont;
  const systemDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme !== 'light' && systemDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (font === 'inter' || font === 'grotesk' || font === 'plex' || font === 'dm' || font === 'mono') {
    document.documentElement.dataset.font = font;
  }
} catch {
  // Private mode etc. — App applies defaults after mount.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
