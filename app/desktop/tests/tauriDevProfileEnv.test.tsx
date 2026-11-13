import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  buildBeforeDevCommand,
  desktopDevCapabilities,
  macDevAppBundleEnv,
  resolveDesktopDevUrl,
  resolveDesktopPreviewIcons,
} from '../scripts/tauri-dev-env.mjs';

const appShellFrameSource = readFileSync(new URL('../src/app/AppShellFrame.tsx', import.meta.url), 'utf8');
const defaultCapability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));

test('named desktop preview permits only its configured API origin', () => {
  const [capability] = desktopDevCapabilities(defaultCapability, 'http://127.0.0.1:17642');
  const httpPermission = capability.permissions.find((permission: { identifier?: string }) => permission.identifier === 'http:default');
  assert.ok(httpPermission);
  assert.deepEqual(httpPermission.allow, [{ url: 'http://127.0.0.1:17642' }]);
  assert.ok(!defaultCapability.permissions.find((permission: { identifier?: string }) => permission.identifier === 'http:default').allow.some((scope: { url: string }) => scope.url === 'http://127.0.0.1:17642'));

  const [remoteCapability] = desktopDevCapabilities(defaultCapability, 'https://test.example');
  const remotePermission = remoteCapability.permissions.find((permission: { identifier?: string }) => permission.identifier === 'http:default');
  assert.deepEqual(remotePermission.allow, [{ url: 'https://test.example' }]);
});

test('native startup preserves the title selected by a named Tauri profile', () => {
  const source = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /set_title\("Kordi"\)/);
});

test('buildBeforeDevCommand does not forward removed edition env into the Vite dev server command', () => {
  const command = buildBeforeDevCommand({
    title: 'Kordi Cloud',
    host: '127.0.0.1',
    port: 1492,
    env: {
      KORDI_EDITION: 'local',
      VITE_KORDI_EDITION: 'local',
      VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081',
    },
  });

  assert.match(command, /^VITE_KORDI_WINDOW_TITLE='Kordi Cloud' /);
  assert.doesNotMatch(command, /VITE_KORDI_EDITION|KORDI_EDITION/);
  assert.match(command, /npm run dev:web -- --host 127\.0\.0\.1 --port 1492 --strictPort$/);
});

test('buildBeforeDevCommand forwards explicit Cloud API base into the Vite dev server command', () => {
  const command = buildBeforeDevCommand({
    title: 'Kordi Cloud',
    host: '127.0.0.1',
    port: 1482,
    env: { VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081' },
  });

  assert.match(command, / VITE_KORDI_CLOUD_API_BASE='http:\/\/127\.0\.0\.1:17081' /);
  assert.match(command, / VITE_KORDI_DEV_PROFILE='community' /);
});

test('buildBeforeDevCommand fails closed without a debug server origin', () => {
  assert.throws(
    () => buildBeforeDevCommand({
      title: 'Kordi',
      host: '127.0.0.1',
      port: 1420,
      env: {},
    }),
    /VITE_KORDI_CLOUD_API_BASE is required for development/i,
  );
});

test('buildBeforeDevCommand rejects the production origin', () => {
  for (const productionOrigin of [
    'https://kordi.ai',
    'http://kordi.ai',
    'https://kordi.ai./',
  ]) {
    assert.throws(
      () => buildBeforeDevCommand({
        title: 'Kordi',
        host: '127.0.0.1',
        port: 1420,
        env: { VITE_KORDI_CLOUD_API_BASE: productionOrigin },
      }),
      /production Cloud API is blocked in development/i,
    );
  }
});

test('buildBeforeDevCommand permits production only for acknowledged operator runs', () => {
  const base = {
    VITE_KORDI_CLOUD_API_BASE: 'https://kordi.ai',
    VITE_KORDI_DEV_PROFILE: 'operator',
  };
  assert.throws(
    () => buildBeforeDevCommand({
      title: 'Kordi Operator',
      host: '127.0.0.1',
      port: 1420,
      env: base,
    }),
    /blocked in development/i,
  );

  const command = buildBeforeDevCommand({
    title: 'Kordi Operator',
    host: '127.0.0.1',
    port: 1420,
    env: {
      ...base,
      VITE_KORDI_PRODUCTION_DEBUG_ACK: '1',
    },
  });
  assert.match(command, /VITE_KORDI_DEV_PROFILE='operator'/);
  assert.match(command, /VITE_KORDI_PRODUCTION_DEBUG_ACK='1'/);
});

test('desktop preview icons visibly distinguish development from product', () => {
  assert.deepEqual(
    resolveDesktopPreviewIcons({ VITE_KORDI_DEV_PROFILE: 'community' }),
    ['icons/icon-dev.png', 'icons/icon-dev.icns'],
  );
  assert.deepEqual(
    resolveDesktopPreviewIcons({ VITE_KORDI_DEV_PROFILE: 'operator' }),
    ['icons/icon.png', 'icons/icon.icns'],
  );
});

test('named profiles may open one local development preview entry', () => {
  assert.equal(resolveDesktopDevUrl({
    host: '127.0.0.1',
    port: 14371,
    path: '/tests/visual/groupMentionPreview.html',
  }), 'http://127.0.0.1:14371/tests/visual/groupMentionPreview.html');
  assert.throws(
    () => resolveDesktopDevUrl({ host: '127.0.0.1', port: 14371, path: '//example.com' }),
    /local absolute URL path/i,
  );
});

test('named development profiles render a visible in-window instance label', () => {
  assert.match(appShellFrameSource, /if \(!import\.meta\.env\.DEV\) return null;/);
  assert.match(appShellFrameSource, /VITE_KORDI_WINDOW_TITLE/);
  assert.match(appShellFrameSource, /Preview · \{instanceLabel\}/);
  assert.match(appShellFrameSource, /aria-label=\{`Preview instance: \$\{instanceLabel\}`\}/);
});

test('production frontend preview builds before serving and preserves operator authorization', () => {
  const env = { VITE_KORDI_CLOUD_API_BASE: 'https://kordi.ai', VITE_KORDI_DEV_PROFILE: 'operator', VITE_KORDI_PRODUCTION_DEBUG_ACK: '1' };
  const command = buildBeforeDevCommand({ title: 'Memory test', host: '127.0.0.1', port: 62359, frontendMode: 'production', env });
  assert.match(command, /npm run build &&/);
  assert.match(command, /npm run preview -- --host '127\.0\.0\.1' --port 62359 --strictPort/);
  assert.doesNotMatch(command, /dev:web/);
  assert.equal(command.split("VITE_KORDI_DEV_PROFILE='operator'").length - 1, 2);
  assert.throws(() => buildBeforeDevCommand({ title: 'Test', host: '127.0.0.1', port: 62359, frontendMode: 'production', env: { ...env, VITE_KORDI_PRODUCTION_DEBUG_ACK: '' } }));
  assert.throws(() => buildBeforeDevCommand({ title: 'Test', host: '127.0.0.1', port: 62359, frontendMode: 'invalid', env }));
});

test('macOS previews run the debug binary from a signed app bundle so permission prompts can appear', () => {
  const options = { identifier: 'io.kordi.cloud.feature-a', title: 'Kordi Feature A', targetTriple: 'aarch64-apple-darwin', runnerPath: '/repo/runner.sh' };
  assert.deepEqual(macDevAppBundleEnv({ ...options, platform: 'darwin', env: {} }), {
    CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER: '/repo/runner.sh',
    KORDI_DEV_BUNDLE_IDENTIFIER: 'io.kordi.cloud.feature-a',
    KORDI_DEV_BUNDLE_NAME: 'Kordi Feature A',
  });
  assert.deepEqual(macDevAppBundleEnv({ ...options, platform: 'linux', env: {} }), {});
  assert.deepEqual(macDevAppBundleEnv({ ...options, platform: 'darwin', env: { KORDI_DEV_APP_BUNDLE: '0' } }), {});
  assert.deepEqual(macDevAppBundleEnv({ ...options, platform: 'darwin', env: { CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER: 'custom' } }), {});
  const runner = readFileSync(new URL('../scripts/macos-dev-app-runner.sh', import.meta.url), 'utf8');
  assert.match(runner, /CFBundleIdentifier/);
  assert.match(runner, /codesign --force --sign -/);
});

test('the macOS dev runner starts the app as its own privacy-responsible process and keeps the fallbacks', () => {
  const runner = readFileSync(new URL('../scripts/macos-dev-app-runner.sh', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('../scripts/macos-disclaim-exec.c', import.meta.url), 'utf8');
  assert.match(runner, /exec "\$helper" "\$app\/Contents\/MacOS\/\$exe" "\$@"/, 'the bundle runs through the disclaim helper');
  assert.match(runner, /KORDI_DEV_APP_DISCLAIM/, 'the helper can be turned off');
  assert.match(runner, /exec "\$app\/Contents\/MacOS\/\$exe" "\$@"/, 'without the helper the bundle still starts');
  assert.match(runner, /exec "\$binary" "\$@"\s*$/, 'the bare binary stays the last fallback');
  // Exec semantics keep the pid, output and signals that Tauri dev relies on.
  assert.match(helper, /responsibility_spawnattrs_setdisclaim\(&attrs, 1\)/);
  assert.match(helper, /POSIX_SPAWN_SETEXEC/);
  assert.match(helper, /execv\(argv\[1\], argv \+ 1\)/);
});

test('the macOS dev runner passes arguments, environment, output and exit status through the bundle', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kordi-dev-runner-'));
  try {
    const binary = join(dir, 'kordi-desktop');
    writeFileSync(binary, '#!/bin/sh\necho "pid=$$ path=$0 args=$#:$1 env=$KORDI_RUNNER_PROBE"\necho stderr-line >&2\nexit 7\n');
    chmodSync(binary, 0o755);
    const runner = fileURLToPath(new URL('../scripts/macos-dev-app-runner.sh', import.meta.url));
    const result = spawnSync('/bin/bash', ['-c', 'echo "runner=$$"; exec "$0" "$@"', runner, binary, 'a b', 'c'], {
      encoding: 'utf8',
      env: { ...process.env, KORDI_DEV_BUNDLE_IDENTIFIER: 'io.kordi.cloud.runner-test', KORDI_DEV_BUNDLE_NAME: 'Kordi Runner Test', KORDI_RUNNER_PROBE: 'kept' },
    });
    assert.equal(result.status, 7, result.stderr);
    assert.match(result.stderr, /stderr-line/);
    const runnerPid = /runner=(\d+)/.exec(result.stdout)?.[1];
    assert.match(result.stdout, new RegExp(`pid=${runnerPid} `), 'the app replaces the runner process');
    assert.match(result.stdout, /path=\S*\/Kordi Runner Test\.app\/Contents\/MacOS\/kordi-desktop/);
    assert.match(result.stdout, /args=2:a b env=kept/);
    if (spawnSync('/bin/sh', ['-c', 'command -v cc'], { encoding: 'utf8' }).status === 0) {
      assert.ok(existsSync(join(dir, 'dev-app-bundles/.launcher/macos-disclaim-exec')), 'the disclaim helper was built');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
