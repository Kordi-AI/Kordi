import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('desktop update path contains no URL-driven native installer or destructive app replacement', () => {
  const rust = source('../src-tauri/src/lib.rs');
  const desktop = source('../src/lib/desktop.ts');
  const sidebar = source('../src/pages/WorkspaceSidebar.tsx');

  for (const text of [rust, desktop, sidebar]) {
    assert.doesNotMatch(text, /desktop_check_for_updates/);
    assert.doesNotMatch(text, /desktop_install_update/);
    assert.doesNotMatch(text, /install-kordi-update\.sh/);
    assert.doesNotMatch(text, /rm -rf ["']?\/Applications/);
  }
  assert.doesNotMatch(rust, /Update download URL must be http or https/);
  assert.doesNotMatch(desktop, /downloadUrl/);
  assert.doesNotMatch(sidebar, /downloadUrl/);
  assert.doesNotMatch(sidebar, /onInstallUpdate\?\(\{[^}]*url/i);
});

test('the real updater adapter delegates download and install to the native update module', () => {
  const controller = source('../src/features/updates/desktopUpdater.ts');
  const native = source('../src-tauri/src/desktop_update.rs');
  const lifecycle = source('../src-tauri/src/window_lifecycle.rs');

  for (const command of ['desktop_update_check', 'desktop_update_download', 'desktop_update_install', 'desktop_update_reveal_app', 'desktop_relaunch_after_update']) {
    assert.match(controller, new RegExp(`invoke(<[^>]+>)?\\('${command}'`));
  }
  assert.doesNotMatch(controller, /@tauri-apps\/plugin-updater/);
  assert.doesNotMatch(controller, /@tauri-apps\/plugin-process/);
  assert.match(native, /tauri_plugin_updater::/);
  assert.match(native, /fn install_downloaded_update_on_exit/);
  assert.match(native, /fn classify_install_location/);
  assert.match(lifecycle, /Command::new\("\/usr\/bin\/open"\)/);
  assert.match(lifecycle, /\.arg\("-n"\)/);
  assert.match(lifecycle, /--kordi-update-relaunch/);
  assert.match(lifecycle, /app\.exit\(tauri::RESTART_EXIT_CODE\)/);
  assert.match(controller, /manualUpdateUrlForVersion\(update\.version\)/);
  assert.doesNotMatch(controller, /http:\/\//);
});

test('updater OS eligibility is backed by the native product version, not a web user agent', () => {
  const updater = source('../src/features/updates/desktopUpdater.ts');
  const native = source('../src-tauri/src/desktop_update.rs');
  const session = source('../src-tauri/src/cloud_session.rs');
  assert.match(native, /cloud_session::cloud_device_system_metadata/);
  assert.match(native, /X-Kordi-OS-Version/);
  assert.match(session, /command_output\("\/usr\/bin\/sw_vers", &\["-productVersion"\]\)/);
  assert.doesNotMatch(updater, /navigator\.(userAgent|platform)/);
});
