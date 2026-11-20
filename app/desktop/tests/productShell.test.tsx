import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloudStartingScreen, KordiAppRoot } from '../src/KordiApp';
import { KORDI_THEME_MODE_STORAGE_KEY } from '../src/app/themePreference';
import { CloudSignInGate } from '../src/kordi-app/cloud/CloudSignInGate';
import { KordiFlyingBird } from '../src/features/cloud/KordiFlyingBird';
import { shouldShowCloudLoginGate } from '../src/features/cloud/sessionGate';
import { readDesktopShellCss } from './helpers/readDesktopStyles';
const repoRoot = resolve(import.meta.dirname, '..');

function makeStorageStub(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
  };
}

function withWindowTheme<T>({
  storedTheme,
  systemPrefersLight = false,
}: {
  storedTheme: 'light' | 'dark' | 'auto';
  systemPrefersLight?: boolean;
}, run: () => T): T {
  const storage = makeStorageStub({ [KORDI_THEME_MODE_STORAGE_KEY]: storedTheme });
  const target = globalThis as typeof globalThis & { window?: Window & typeof globalThis };
  const previousWindow = target.window;
  target.window = {
    localStorage: storage,
    matchMedia: () => ({
      matches: systemPrefersLight,
      media: '(prefers-color-scheme: light)',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  } as Window & typeof globalThis;
  try {
    return run();
  } finally {
    if (previousWindow) target.window = previousWindow;
    else delete target.window;
  }
}

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
}

import {
  applyCloudLoginWindowSize,
  applyKordiMainWindowSize,
  CLOUD_WELCOME_WINDOW_SIZE,
  isTauriRuntime,
  supportsFrostedGate,
} from '../src/features/cloud/loginWindow';

test('cloud shell source does not expose localhost bridge controls', () => {
  const navigation = readSource('src/kordi-app/data/navigation.tsx');
  const sidebar = readSource('src/pages/WorkspaceSidebar.tsx');
  const rightDetail = readSource('src/app/assembleRightDetailSlot.tsx');

  assert.doesNotMatch(navigation, /id: 'bridge'/);
  assert.doesNotMatch(sidebar, /Refresh bridge state|Copy host URL|Add \/ join another host/);
  assert.doesNotMatch(rightDetail, /onOpenBridgeHosts|handleCreateProjectBridgeInvite/);
});

test('session gate source has no runtime product-mode parser', () => {
  const source = readSource('src/features/cloud/sessionGate.ts');

  assert.doesNotMatch(source, /KORDI_EDITION|VITE_KORDI_EDITION|currentKordiEdition|normalizeKordiEdition|kordiEditionFromEnv|kordiEditionFromRuntimeHints/);
});

test('cloud login gate always uses Cloud product semantics', () => {
  assert.equal(shouldShowCloudLoginGate({ cloudSessionStatus: 'authenticated' }), false);
  assert.equal(shouldShowCloudLoginGate({ cloudSessionStatus: 'signed-out' }), true);
});

test('cloud window surfaces are the compact welcome window and the workspace', async () => {
  assert.equal(isTauriRuntime({ __TAURI_INTERNALS__: {} } as typeof globalThis), true);
  assert.equal(isTauriRuntime({} as typeof globalThis), false);
  // Browser renders have no native IPC dependency.
  await applyCloudLoginWindowSize('welcome');
  await applyKordiMainWindowSize();
  // The native shell has no other signed-out window size.
  const nativeWindow = readSource('src-tauri/src/auth_window.rs');
  const surfaces = nativeWindow.match(/pub\(crate\) enum AuthWindowSurface \{([^}]*)\}/)?.[1] ?? '';
  assert.deepEqual(surfaces.match(/^\s*[A-Z]\w*,/gm)?.map((line) => line.trim()), ['Welcome,', 'Main,']);
});

test('browser sign-in uses a compact frosted window on macOS only', () => {
  assert.deepEqual(CLOUD_WELCOME_WINDOW_SIZE, { width: 440, height: 480 });
  const runtime = (platform: string, native = true) => ({
    ...(native ? { __TAURI_INTERNALS__: {} } : {}),
    navigator: { platform },
  }) as unknown as typeof globalThis;
  assert.equal(supportsFrostedGate(runtime('MacIntel')), true);
  assert.equal(supportsFrostedGate(runtime('Win32')), false, 'other platforms keep an opaque page');
  assert.equal(supportsFrostedGate(runtime('MacIntel', false)), false, 'browser renders have no material');

  const nativeWindow = readSource('src-tauri/src/auth_window.rs');
  assert.match(nativeWindow, /Self::Welcome => \(440\.0, 480\.0,/);
  assert.match(nativeWindow, /MAIN_FRAME/, 'the main frame is remembered across a sign-out');

  assert.match(readSource('src/styles/base.css'), /html\.kordi-native-shell body\.app-cloud-gate-active\.app-cloud-gate-frosted \{\s*background: transparent;/);
  const css = readDesktopShellCss();
  // A faint veil at most, so the blurred wallpaper stays visible.
  assert.match(css, /theme-light\.app-cloud-login-shell\[data-frosted="true"\] \.app-cloud-login-page \{\s*--app-cloud-login-page-bg: rgb\(255 255 255 \/ 0\.10\);/);
  assert.match(css, /\.kordi-app\.app-cloud-login-shell\[data-frosted="true"\] \.app-cloud-login-page \{\s*--app-cloud-login-page-bg: rgb\(14 16 20 \/ 0\.82\);/);
  assert.match(css, /\[data-frosted="true"\] \.app-cloud-starting-screen\[data-visible="false"\]::before \{\s*opacity: 0;/);
  const windowLayout = readSource('src-tauri/src/auth_window/layout.rs');
  assert.match(windowLayout, /let material: isize = if welcome \{ 13 \} else \{ 7 \};/, 'the welcome window uses the HUD material');
  // The frame is the visible window, clear of the title bar, with the group just above center.
  assert.match(css, /\.app-cloud-browser-signin \{[^}]*position: fixed;[^}]*width: var\(--app-gate-window-width,[^}]*padding: 52px 24px 76px;/);
  assert.match(css, /\.app-cloud-welcome-actions \{[^}]*max-width: 304px;/);
});

test('the welcome screen has no in-page window title and cuts the wing gap out of the bird', () => {
  const page = readSource('src/kordi-app/cloud/CloudBrowserSignInPage.tsx');
  assert.doesNotMatch(page, />\s*Kordi\s*</);
  assert.match(page, /<KordiFlyingBird className="app-cloud-welcome-bird" cutout \/>/);

  // The gap is a hole in the body path, not a mask (see kordiFlyingBird.test.tsx).
  const cutout = renderToStaticMarkup(createElement(KordiFlyingBird, { cutout: true }));
  assert.doesNotMatch(cutout, /<mask/);
  assert.match(cutout, /class="app-kordi-flying-bird app-kordi-flying-bird-cutout"/);
  const plain = renderToStaticMarkup(createElement(KordiFlyingBird));
  assert.doesNotMatch(plain, /<mask/);
});

test('cloud starting screen renders only the flying Kordi bird', () => {
  const markup = renderToStaticMarkup(createElement(CloudStartingScreen));

  assert.match(markup, /app-cloud-starting-screen/);
  assert.equal((markup.match(/class="app-kordi-flying-bird app-cloud-starting-bird"/g) ?? []).length, 1);
  assert.match(markup, /app-kordi-flying-bird-wing/);
  assert.doesNotMatch(markup, /Starting/);
  assert.doesNotMatch(markup, /Restoring session/);
});

test('cloud starting timeout provides an explicit retry action', () => {
  const markup = renderToStaticMarkup(createElement(CloudStartingScreen, { status: 'error', onRetry: () => {} }));

  assert.match(markup, /app-cloud-starting-screen-error/);
  assert.match(markup, /app-cloud-starting-bird/);
  assert.match(markup, /Retry sync/);
  assert.match(markup, /button/);
});

test('cloud starting bird flaps flat, without glow, and stops for reduced motion', () => {
  const css = readDesktopShellCss();
  const wingBlock = cssBlock(css, '.app-kordi-flying-bird-wing');

  assert.match(wingBlock, /animation:\s*app-kordi-bird-flap/);
  assert.match(wingBlock, /transform-origin:\s*0% 50%/);
  assert.doesNotMatch(css, /\.app-kordi-flying-bird[^{]*\{[^}]*(filter:|drop-shadow|box-shadow)/);
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.app-kordi-flying-bird-body,\s*\.app-kordi-flying-bird-wing\s*\{\s*animation:\s*none;/);
});

test('session restore uses the same bird loading screen', () => {
  const markup = renderToStaticMarkup(createElement(KordiAppRoot, {
    cloudSessionStatus: 'loading',
    cloudSession: {
      status: 'loading',
      account: null,
    },
  }));

  assert.match(markup, /app-cloud-starting-screen/);
  assert.match(markup, /app-cloud-starting-bird/);
  assert.doesNotMatch(markup, /Restoring session/);
});

test('app root renders the sign-in welcome screen before the chat shell, never a credential form', () => {
  const markup = renderToStaticMarkup(createElement(KordiAppRoot, {
    cloudSessionStatus: 'signed-out',
  }));

  assert.match(markup, /Welcome to Kordi/);
  assert.match(markup, />Log in</);
  assert.match(markup, />Sign up</);
  assert.doesNotMatch(markup, /<input|<form|type="password"|type="email"|Password|Continue with/);
  assert.doesNotMatch(markup, /Connect a model to start/);
  assert.doesNotMatch(markup, /Ask your agent/);
});

test('cloud login gate applies stored light theme on the kordi-app root', () => {
  const markup = withWindowTheme({ storedTheme: 'light' }, () => renderToStaticMarkup(createElement(KordiAppRoot, {
    cloudSessionStatus: 'signed-out',
  })));

  assert.match(markup, /class="kordi-app app-cloud-login-shell theme-light"/);
  assert.doesNotMatch(markup, /class="kordi-app app-cloud-login-shell"/);
});

test('cloud session restore gate applies stored dark theme on the kordi-app root', () => {
  const markup = withWindowTheme({ storedTheme: 'dark' }, () => renderToStaticMarkup(createElement(KordiAppRoot, {
    cloudSessionStatus: 'loading',
    cloudSession: {
      status: 'loading',
      account: null,
    },
  })));

  assert.match(markup, /class="kordi-app app-cloud-login-shell theme-dark"/);
  assert.match(markup, /app-cloud-starting-screen/);
});

test('cloud gate auto theme follows system light before shell mount', () => {
  const markup = withWindowTheme({ storedTheme: 'auto', systemPrefersLight: true }, () => renderToStaticMarkup(createElement(KordiAppRoot, {
    cloudSessionStatus: 'signed-out',
  })));

  assert.match(markup, /class="kordi-app app-cloud-login-shell theme-light"/);
});

test('cloud login gate reads persisted theme preference and native system theme before shell mount', () => {
  const source = readSource('src/features/cloud/CloudGateShell.tsx');
  const baseCss = readSource('src/styles/base.css');
  const capabilities = readSource('src-tauri/capabilities/default.json');

  assert.match(source, /readStoredThemeMode/);
  assert.match(source, /resolveThemeMode\(themeMode, readSystemTheme\(\)\)/);
  assert.match(source, /themeMode === 'auto' && isTauriRuntime\(\)/);
  assert.match(source, /getCurrentWindow\(\)\.theme\(\)/);
  assert.match(source, /getCurrentWindow\(\)\.onThemeChanged/);
  assert.match(source, /nativeWindowThemeIsResolvedTheme/);
  assert.match(source, /classList\.toggle\('app-cloud-gate-active', active\)/);
  assert.match(source, /!active\s*\? APP_WINDOW_BACKGROUND\[theme\]\s*: frosted \? FROSTED_GATE_WINDOW_BACKGROUND : GATE_WINDOW_BACKGROUND\[theme\]/);
  assert.match(baseCss, /body\.app-cloud-gate-active\.theme-light\s*\{[^}]*background:\s*linear-gradient\(180deg, rgb\(248 250 252\)/s);
  assert.match(capabilities, /core:window:allow-set-background-color/);
  assert.doesNotMatch(source, /const \[theme, setTheme\] = useState<ResolvedThemeMode>\(\(\) => readSystemTheme\(\)\)/);
});

test('cloud login gate has a native drag fallback before the app shell mounts', () => {
  const shellSource = readSource('src/features/cloud/CloudGateShell.tsx');
  const loginMarkup = renderToStaticMarkup(createElement(CloudSignInGate));

  assert.match(shellSource, /shouldStartNativeWindowDrag/);
  assert.match(shellSource, /isTauriRuntime\(\)/);
  assert.match(shellSource, /getCurrentWindow\(\)\.startDragging\(\)/);
  assert.match(shellSource, /onMouseDownCapture=\{handleGateWindowDragMouseDown\}/);
  assert.match(loginMarkup, /data-tauri-drag-region="true"/);
});
