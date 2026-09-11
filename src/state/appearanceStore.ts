import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Minimal appearance state (theme + font), persisted separately from the
 * diagram so it never touches the diagram persistence architecture.
 * Defaults: system theme (follows the OS), Inter font stack.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
export type FontChoice = 'inter' | 'geist' | 'plex' | 'mono' | 'system';

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
    { name: 'sanklean:appearance:v1', version: 1 },
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
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
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
