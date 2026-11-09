import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDesktopUpdaterController,
  manualUpdateUrlForVersion,
  type DesktopUpdaterAdapter,
  type DesktopUpdaterCheck,
  type DesktopUpdaterDownloadEvent,
  type DesktopUpdaterLocation,
  type DesktopUpdaterUpdate,
} from '../src/features/updates/desktopUpdater';

const BETA6_MANUAL_UPDATE_URL =
  'https://kordi.ai/updates/releases/0.0.1-beta.6/Kordi_0.0.1-beta.6_aarch64.dmg';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeUpdate(overrides: Partial<DesktopUpdaterUpdate> = {}): DesktopUpdaterUpdate {
  return {
    currentVersion: '0.0.1-beta.5.1',
    version: '0.0.1-beta.6',
    body: 'Signed beta.6 update',
    ...overrides,
  };
}

type FakeAdapter = DesktopUpdaterAdapter & {
  calls: string[];
  nextCheck: () => Promise<DesktopUpdaterCheck>;
  downloadImpl: (listener: (event: DesktopUpdaterDownloadEvent) => void) => Promise<void>;
  installImpl: () => Promise<void>;
  relaunchImpl: () => Promise<void>;
};

function fakeAdapter(
  update: DesktopUpdaterUpdate | null,
  location: DesktopUpdaterLocation = 'applications',
): FakeAdapter {
  const adapter: FakeAdapter = {
    calls: [],
    nextCheck: async () => ({ update, location }),
    downloadImpl: async (listener) => {
      listener({ event: 'Started', data: { contentLength: 100 } });
      listener({ event: 'Progress', data: { chunkLength: 100 } });
      listener({ event: 'Finished' });
    },
    installImpl: async () => {},
    relaunchImpl: async () => {},
    async check() {
      adapter.calls.push('check');
      return adapter.nextCheck();
    },
    async download(listener) {
      adapter.calls.push('download');
      return adapter.downloadImpl(listener);
    },
    async install() {
      adapter.calls.push('install');
      return adapter.installImpl();
    },
    async relaunch() {
      adapter.calls.push('relaunch');
      return adapter.relaunchImpl();
    },
    async revealApp() {
      adapter.calls.push('reveal');
    },
    async currentVersion() {
      return update?.currentVersion ?? '0.0.1-beta.7';
    },
  };
  return adapter;
}

function controllerFor(adapter: DesktopUpdaterAdapter, autoDownload = false) {
  return createDesktopUpdaterController({ adapter, isTauriRuntime: () => true, autoDownload: () => autoDownload });
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test('manual fallback is product-origin and version-immutable', () => {
  assert.equal(manualUpdateUrlForVersion('0.0.1-beta.6'), BETA6_MANUAL_UPDATE_URL);
  assert.equal(
    manualUpdateUrlForVersion('10.20.30-beta.4'),
    'https://kordi.ai/updates/releases/10.20.30-beta.4/Kordi_10.20.30-beta.4_aarch64.dmg',
  );
  for (const value of [undefined, '', 'latest', '../beta.6', '0.0.1-beta.06', 'https://evil.invalid/x']) {
    assert.equal(manualUpdateUrlForVersion(value), undefined);
  }
});

test('outside Tauri the controller stays idle without checking', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  const controller = createDesktopUpdaterController({ adapter, isTauriRuntime: () => false });
  assert.equal((await controller.check()).status, 'idle');
  assert.deepEqual(adapter.calls, []);
});

test('with automatic updates off, a found update waits for the user', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  const controller = controllerFor(adapter, false);
  const state = await controller.check();
  await settle();
  assert.equal(state.status, 'available');
  assert.equal(state.latestVersion, '0.0.1-beta.6');
  assert.equal(state.manualDownloadUrl, BETA6_MANUAL_UPDATE_URL);
  assert.deepEqual(adapter.calls, ['check']);
});

test('with automatic updates on, a found update downloads silently and becomes ready', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  const controller = controllerFor(adapter, true);
  const states: Array<[string, boolean | undefined]> = [];
  controller.subscribe((state) => states.push([state.status, state.background]));
  await controller.check();
  await settle();
  assert.deepEqual(adapter.calls, ['check', 'download']);
  assert.equal(controller.getState().status, 'ready');
  assert.ok(states.some(([status, background]) => status === 'downloading' && background === true));
  assert.ok(!adapter.calls.includes('install'), 'nothing installs before the user restarts or quits');
});

test('a failed silent download falls back to the manual offer without an error card', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  adapter.downloadImpl = async () => { throw new Error('network dropped'); };
  const controller = controllerFor(adapter, true);
  await controller.check();
  await settle();
  assert.equal(controller.getState().status, 'available');
  assert.equal(controller.getState().error, undefined);
});

test('restart to update installs the downloaded bytes without downloading again, then relaunches', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  const controller = controllerFor(adapter, true);
  await controller.check();
  await settle();
  await controller.install();
  assert.deepEqual(adapter.calls, ['check', 'download', 'install', 'relaunch']);
  assert.equal(controller.getState().status, 'relaunching');
});

test('update now downloads with progress, installs, and relaunches only after success', async () => {
  const install = deferred<void>();
  let emit: ((event: DesktopUpdaterDownloadEvent) => void) | undefined;
  const finishDownload = deferred<void>();
  const adapter = fakeAdapter(fakeUpdate());
  adapter.downloadImpl = async (listener) => { emit = listener; await finishDownload.promise; };
  adapter.installImpl = () => install.promise;
  const controller = controllerFor(adapter, false);
  await controller.check();

  const pending = controller.install();
  await settle();
  assert.equal(controller.getState().status, 'downloading');
  assert.equal(controller.getState().background, false);
  emit?.({ event: 'Started', data: { contentLength: 200 } });
  emit?.({ event: 'Progress', data: { chunkLength: 50 } });
  assert.equal(controller.getState().receivedBytes, 50);
  assert.equal(controller.getState().totalBytes, 200);
  finishDownload.resolve();
  await settle();
  assert.equal(controller.getState().status, 'installing');
  assert.ok(!adapter.calls.includes('relaunch'));
  install.resolve();
  await pending;
  assert.deepEqual(adapter.calls, ['check', 'download', 'install', 'relaunch']);
});

test('install failure never relaunches and retry installs the same downloaded update', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  let installs = 0;
  adapter.installImpl = async () => {
    installs += 1;
    if (installs === 1) throw new Error('signature mismatch');
  };
  const controller = controllerFor(adapter, false);
  await controller.check();
  await assert.rejects(controller.install(), /signature mismatch/);
  assert.equal(controller.getState().status, 'failed');
  assert.equal(controller.getState().failureStage, 'install');
  assert.equal(controller.getState().error, 'signature mismatch');
  assert.ok(!adapter.calls.includes('relaunch'));
  await controller.retry();
  assert.deepEqual(adapter.calls, ['check', 'download', 'install', 'install', 'relaunch']);
});

test('a manual download failure shows the error card with manual recovery', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  adapter.downloadImpl = async () => { throw new Error(''); };
  const controller = controllerFor(adapter, false);
  await controller.check();
  await assert.rejects(controller.install());
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(state.error, 'Unable to install the verified Kordi update.');
  assert.equal(state.manualDownloadUrl, BETA6_MANUAL_UPDATE_URL);
});

test('relaunch failure leaves an actionable failed state', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  adapter.relaunchImpl = async () => { throw new Error('Quit Kordi and open it from Applications.'); };
  const controller = controllerFor(adapter, true);
  await controller.check();
  await settle();
  await assert.rejects(controller.install());
  assert.equal(controller.getState().status, 'failed');
  assert.equal(controller.getState().error, 'Quit Kordi and open it from Applications.');
});

test('a copy outside Applications never downloads or installs and offers to move instead', async () => {
  const adapter = fakeAdapter(fakeUpdate(), 'elsewhere');
  const controller = controllerFor(adapter, true);
  const state = await controller.check();
  await settle();
  assert.equal(state.status, 'misplaced');
  assert.deepEqual(adapter.calls, ['check']);
  await assert.rejects(controller.install(), /Move Kordi to Applications/);
  await controller.downloadInBackground();
  await controller.revealApp();
  assert.deepEqual(adapter.calls, ['check', 'reveal']);
});

test('turning automatic updates on starts the download for a waiting update', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  const controller = controllerFor(adapter, false);
  await controller.check();
  await controller.downloadInBackground();
  assert.equal(controller.getState().status, 'ready');
  assert.deepEqual(adapter.calls, ['check', 'download']);
});

test('a recheck keeps a downloaded update ready and a failed recheck does not discard it', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  const controller = controllerFor(adapter, true);
  await controller.check();
  await settle();
  assert.equal((await controller.check()).status, 'ready');
  adapter.nextCheck = async () => { throw new Error('offline'); };
  assert.equal((await controller.check()).status, 'ready');
  assert.deepEqual(adapter.calls, ['check', 'download', 'check', 'check']);
});

test('a newer version replaces a downloaded one and downloads again', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  const controller = controllerFor(adapter, true);
  await controller.check();
  await settle();
  adapter.nextCheck = async () => ({ update: fakeUpdate({ version: '0.0.1-beta.7' }), location: 'applications' });
  await controller.check();
  await settle();
  assert.equal(controller.getState().latestVersion, '0.0.1-beta.7');
  assert.equal(controller.getState().status, 'ready');
  assert.deepEqual(adapter.calls, ['check', 'download', 'check', 'download']);
});

test('concurrent checks share one request and publish checking then up-to-date', async () => {
  const result = deferred<DesktopUpdaterCheck>();
  const adapter = fakeAdapter(null);
  adapter.nextCheck = () => result.promise;
  const controller = controllerFor(adapter);
  const states: string[] = [];
  controller.subscribe((state) => states.push(state.status));
  const first = controller.check();
  const second = controller.check();
  assert.equal(first, second);
  await settle();
  assert.deepEqual(adapter.calls, ['check']);
  result.resolve({ update: null, location: 'applications' });
  assert.deepEqual(await first, { status: 'up-to-date', currentVersion: '0.0.1-beta.7' });
  assert.deepEqual(states, ['checking', 'up-to-date']);
});

test('a failed check stays visible and retry performs a new check', async () => {
  const adapter = fakeAdapter(null);
  let checks = 0;
  adapter.nextCheck = async () => {
    checks += 1;
    if (checks === 1) throw new Error('update service offline');
    return { update: null, location: 'applications' };
  };
  const controller = controllerFor(adapter);
  assert.deepEqual(await controller.check(), {
    status: 'failed',
    currentVersion: '0.0.1-beta.7',
    failureStage: 'check',
    error: 'update service offline',
  });
  assert.equal((await controller.retry())?.status, 'up-to-date');
  assert.equal(checks, 2);
});

test('a failed recheck preserves the known manual-download recovery', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  const controller = controllerFor(adapter);
  await controller.check();
  adapter.nextCheck = async () => { throw new Error('temporary network failure'); };
  const failed = await controller.check();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.latestVersion, '0.0.1-beta.6');
  assert.equal(failed.manualDownloadUrl, BETA6_MANUAL_UPDATE_URL);
});

test('an invalid update version never becomes a manual download URL', async () => {
  const controller = controllerFor(fakeAdapter(fakeUpdate({ version: 'https://evil.invalid/x' })));
  const state = await controller.check();
  assert.equal(state.status, 'available');
  assert.equal(state.manualDownloadUrl, undefined);
});
