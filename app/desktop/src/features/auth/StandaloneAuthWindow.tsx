import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { syncNativeWindowTheme } from '@/app/nativeWindowTheme';
import {
  applyChatTheme,
  KORDI_CHAT_THEME_STORAGE_KEY,
  KORDI_THEME_MODE_STORAGE_KEY,
  readStoredChatTheme,
  readStoredThemeMode,
  resolveThemeMode,
} from '@/app/themePreference';
import type { ResolvedThemeMode } from '@/kordi-app/types';

export function StandaloneAuthWindow({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState(() => readStoredThemeMode());
  const [systemTheme, setSystemTheme] = useState<ResolvedThemeMode>(() => (
    window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  ));
  const theme = resolveThemeMode(mode, systemTheme);

  useEffect(() => {
    const mediaQuery = window.matchMedia?.('(prefers-color-scheme: light)');
    const updateSystemTheme = () => setSystemTheme(mediaQuery?.matches ? 'light' : 'dark');
    const updatePreferences = (event: StorageEvent) => {
      if (event.key === null || event.key === KORDI_THEME_MODE_STORAGE_KEY) setMode(readStoredThemeMode());
      if (event.key === null || event.key === KORDI_CHAT_THEME_STORAGE_KEY) applyChatTheme(readStoredChatTheme());
    };

    mediaQuery?.addEventListener('change', updateSystemTheme);
    window.addEventListener('storage', updatePreferences);
    return () => {
      mediaQuery?.removeEventListener('change', updateSystemTheme);
      window.removeEventListener('storage', updatePreferences);
    };
  }, []);

  useLayoutEffect(() => {
    document.documentElement.style.colorScheme = theme;
    return () => { document.documentElement.style.removeProperty('color-scheme'); };
  }, [theme]);

  useEffect(() => {
    void syncNativeWindowTheme(mode).catch(() => undefined);
  }, [mode]);

  return (
    <div className={`kordi-app theme-${theme} flex h-[100dvh] w-full overflow-hidden bg-[color:var(--app-main-bg)] px-6 py-8 text-[color:var(--utility-foreground)]`}>
      {children}
    </div>
  );
}
