import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Minimal appearance state (theme + font), persisted separately from the
 * diagram so it never touches the diagram persistence architecture.
 * Defaults: system theme (follows the OS), Inter font stack.
 *
 * Font set is deliberately differentiated: neutral Inter, geometric
 * Space Grotesk, humanist IBM Plex Sans, soft DM Sans, monospace
 * JetBrains Mono. Each maps to a real webfont (see index.html) so the
 * selection renders visibly differently, not just a relabeled fallback.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
export type FontChoice = 'inter' | 'grotesk' | 'plex' | 'dm' | 'mono';

interface AppearanceState {
  theme: ThemeChoice;
  font: FontChoice;
  setTheme: (theme: ThemeChoice) => void;
  setFont: (font: FontChoice) => void;
}

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      theme: 'system',
      font: 'inter',
      setTheme: (theme) => set({ theme }),
      setFont: (font) => set({ font }),
    }),
    {
      name: 'sanklean:appearance:v1',
      version: 2,
      // Rehydration guard: same-version corrupt values bypass `migrate`,
      // so allowlist here too — unknown values fall back to the defaults
      // instead of rendering an unstyled theme/font.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { theme?: unknown; font?: unknown };
        if (typeof p !== 'object') return current;
        const theme: ThemeChoice =
          p.theme === 'light' || p.theme === 'dark' || p.theme === 'system'
            ? p.theme
            : current.theme;
        const font: FontChoice =
          p.font === 'inter' ||
          p.font === 'grotesk' ||
          p.font === 'plex' ||
          p.font === 'dm' ||
          p.font === 'mono'
            ? p.font
            : current.font;
        return { ...current, theme, font };
      },
      migrate: (persisted, version) => {
        // v1 -> v2: 'geist' (removed) maps to geometric 'grotesk',
        // explicit 'system' (removed) maps to neutral 'inter'.
        // Anything unknown falls back to 'inter' so the UI never renders
        // an unstyled data-font value.
        const state = persisted as { font?: unknown; theme?: unknown };
        if (!state || typeof state !== 'object') return persisted as never;
        if (version < 2) {
          if (state.font === 'geist') return { ...state, font: 'grotesk' } as never;
          if (state.font === 'system') return { ...state, font: 'inter' } as never;
          if (
            state.font !== 'inter' &&
            state.font !== 'grotesk' &&
            state.font !== 'plex' &&
            state.font !== 'dm' &&
            state.font !== 'mono'
          ) {
            return { ...state, font: 'inter' } as never;
          }
        }
        return persisted as never;
      },
    },
  ),
);

function querySystemDark(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false;
  } catch {
    return false;
  }
}

function subscribeToSystemTheme(onChange: () => void): () => void {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    // Modern browsers: MediaQueryList.addEventListener. Safari < 14 only
    // exposes the legacy addListener — support both so the theme follows
    // the OS everywhere instead of silently sticking.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    const legacy = mq as MediaQueryList & {
      addListener?: (listener: () => void) => void;
      removeListener?: (listener: () => void) => void;
    };
    if (typeof legacy.addListener === 'function') {
      legacy.addListener(onChange);
      return () => legacy.removeListener?.(onChange);
    }
    return () => {};
  } catch {
    return () => {};
  }
}

/** Concrete theme that re-resolves while the OS preference changes. */
export function useEffectiveTheme(): 'light' | 'dark' {
  const theme = useAppearanceStore((s) => s.theme);
  const systemDark = useSyncExternalStore(subscribeToSystemTheme, querySystemDark, () => false);
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  return systemDark ? 'dark' : 'light';
}
