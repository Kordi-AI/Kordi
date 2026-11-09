import { clientDistribution } from '../cloud/distribution';
import { readAutoUpdatePreference } from './autoUpdatePreference';
const BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;

export function manualUpdateUrlForVersion(version: string | undefined) {
  if (!version || !BETA_VERSION.test(version)) return undefined;
  const distribution = clientDistribution();
  if (!distribution?.updates.enabled) return undefined;
  const encoded = encodeURIComponent(version);
  return `${distribution.backendOrigin}/updates/releases/${encoded}/${distribution.updates.artifactName}_${encoded}_aarch64.dmg`;
}

export type DesktopUpdaterDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export type DesktopUpdaterUpdate = {
  currentVersion: string;
  version: string;
  body?: string;
  date?: string;
};

/** Where the running Kordi.app lives. Updates only replace a copy in Applications. */
export type DesktopUpdaterLocation = 'applications' | 'elsewhere';

export type DesktopUpdaterCheck = {
  update: DesktopUpdaterUpdate | null;
  location: DesktopUpdaterLocation;
};

export type DesktopUpdaterAdapter = {
  check(): Promise<DesktopUpdaterCheck>;
  download(listener: (event: DesktopUpdaterDownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
  relaunch(): Promise<void>;
  revealApp?(): Promise<void>;
  currentVersion?(): Promise<string>;
};

export type DesktopUpdaterStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'relaunching'
  | 'misplaced'
  | 'failed';

export type DesktopUpdaterState = {
  status: DesktopUpdaterStatus;
  currentVersion?: string;
  latestVersion?: string;
  notes?: string;
  receivedBytes?: number;
  totalBytes?: number;
  /** True while an automatic download runs without the user asking. */
  background?: boolean;
  error?: string;
  manualDownloadUrl?: string;
  failureStage?: 'check' | 'install';
};

type DesktopUpdaterControllerOptions = {
  adapter: DesktopUpdaterAdapter;
  isTauriRuntime: () => boolean;
  /** Whether a found update downloads on its own. */
  autoDownload?: () => boolean;
};

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Unable to install the verified Kordi update.';
}

function checkErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Unable to check for Kordi updates. Check your connection and try again.';
}

function stateForUpdate(
  status: DesktopUpdaterStatus,
  update: DesktopUpdaterUpdate,
  extra: Partial<DesktopUpdaterState> = {},
): DesktopUpdaterState {
  return {
    status,
    currentVersion: update.currentVersion,
    latestVersion: update.version,
    notes: update.body,
    manualDownloadUrl: manualUpdateUrlForVersion(update.version),
    ...extra,
  };
}

export function createDesktopUpdaterController(options: DesktopUpdaterControllerOptions) {
  let state: DesktopUpdaterState = { status: 'idle' };
  let checkedUpdate: DesktopUpdaterUpdate | null = null;
  let downloadedVersion: string | null = null;
  let checkPromise: Promise<DesktopUpdaterState> | null = null;
  let downloadPromise: Promise<void> | null = null;
  let installPromise: Promise<void> | null = null;
  const listeners = new Set<(nextState: DesktopUpdaterState) => void>();

  const publish = (nextState: DesktopUpdaterState) => {
    state = nextState;
    for (const listener of listeners) listener(state);
  };

  const readCurrentVersion = async () => {
    try {
      const version = await options.adapter.currentVersion?.();
      return version?.trim() || state.currentVersion;
    } catch {
      return state.currentVersion;
    }
  };

  const download = (background: boolean) => {
    if (downloadPromise) return downloadPromise;
    const update = checkedUpdate;
    if (!update) return Promise.reject(new Error('No checked Kordi update is available.'));
    if (downloadedVersion === update.version) {
      publish(stateForUpdate('ready', update));
      return Promise.resolve();
    }

    let receivedBytes = 0;
    let totalBytes: number | undefined;
    publish(stateForUpdate('downloading', update, { receivedBytes, background }));
    downloadPromise = (async () => {
      try {
        await options.adapter.download((event) => {
          if (event.event === 'Started') {
            receivedBytes = 0;
            totalBytes = event.data.contentLength;
          } else if (event.event === 'Progress') {
            receivedBytes += event.data.chunkLength;
          } else {
            return;
          }
          publish(stateForUpdate('downloading', update, { receivedBytes, totalBytes, background }));
        });
        downloadedVersion = update.version;
        publish(stateForUpdate('ready', update, { receivedBytes, totalBytes }));
      } catch (error) {
        // A silent download that fails falls back to the manual offer.
        publish(background
          ? stateForUpdate('available', update)
          : stateForUpdate('failed', update, {
            receivedBytes,
            totalBytes,
            failureStage: 'install',
            error: errorMessage(error),
          }));
        throw error;
      } finally {
        downloadPromise = null;
      }
    })();
    return downloadPromise;
  };

  const check = () => {
    if (checkPromise) return checkPromise;
    if (!options.isTauriRuntime()) {
      publish({ status: 'idle' });
      return Promise.resolve(state);
    }
    if (installPromise || downloadPromise) return Promise.resolve(state);

    const previousState = state;
    // A downloaded update keeps its card while the recheck runs.
    if (previousState.status !== 'ready') {
      publish({ status: 'checking', currentVersion: previousState.currentVersion });
    }

    checkPromise = (async () => {
      const currentVersionPromise = readCurrentVersion();
      try {
        const { update, location } = await options.adapter.check();
        if (!update) {
          checkedUpdate = null;
          downloadedVersion = null;
          publish({ status: 'up-to-date', currentVersion: await currentVersionPromise });
          return state;
        }
        checkedUpdate = update;
        if (downloadedVersion !== update.version) downloadedVersion = null;
        if (location !== 'applications') {
          publish(stateForUpdate('misplaced', update));
          return state;
        }
        if (downloadedVersion) {
          publish(stateForUpdate('ready', update));
          return state;
        }
        publish(stateForUpdate('available', update));
        if (options.autoDownload?.()) void download(true).catch(() => {});
        return state;
      } catch (error) {
        if (previousState.status === 'ready') {
          publish(previousState);
          return state;
        }
        checkedUpdate = null;
        publish({
          status: 'failed',
          currentVersion: (await currentVersionPromise) ?? previousState.currentVersion,
          ...(previousState.latestVersion ? { latestVersion: previousState.latestVersion } : {}),
          ...(previousState.manualDownloadUrl ? { manualDownloadUrl: previousState.manualDownloadUrl } : {}),
          failureStage: 'check',
          error: checkErrorMessage(error),
        });
        return state;
      } finally {
        checkPromise = null;
      }
    })();

    return checkPromise;
  };

  const install = () => {
    if (installPromise) return installPromise;
    const update = checkedUpdate;
    if (!update) return Promise.reject(new Error('No checked Kordi update is available.'));
    if (state.status === 'misplaced') {
      return Promise.reject(new Error('Move Kordi to Applications to update it.'));
    }

    installPromise = (async () => {
      try {
        if (downloadedVersion !== update.version) await download(false);
        publish(stateForUpdate('installing', update));
        try {
          await options.adapter.install();
        } catch (error) {
          publish(stateForUpdate('failed', update, { failureStage: 'install', error: errorMessage(error) }));
          throw error;
        }
        downloadedVersion = null;
        publish(stateForUpdate('relaunching', update));
        try {
          await options.adapter.relaunch();
        } catch (error) {
          publish(stateForUpdate('failed', update, { failureStage: 'install', error: errorMessage(error) }));
          throw error;
        }
      } finally {
        installPromise = null;
      }
    })();
    return installPromise;
  };

  return {
    check,
    install,
    /** Starts a silent download when automatic updates turn on. */
    downloadInBackground() {
      if (state.status !== 'available' || installPromise) return Promise.resolve();
      return download(true).catch(() => {});
    },
    revealApp() {
      return options.adapter.revealApp?.() ?? Promise.resolve();
    },
    retry() {
      if (state.status === 'failed' && state.failureStage === 'check') return check();
      return install();
    },
    getState: () => state,
    getCheckedUpdate: () => checkedUpdate,
    subscribe(listener: (nextState: DesktopUpdaterState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      checkedUpdate = null;
      downloadedVersion = null;
      publish({ status: 'idle' });
    },
  };
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

export const tauriDesktopUpdaterAdapter: DesktopUpdaterAdapter = {
  async check() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<DesktopUpdaterCheck>('desktop_update_check');
  },
  async download(listener) {
    const { Channel, invoke } = await import('@tauri-apps/api/core');
    const onEvent = new Channel<DesktopUpdaterDownloadEvent>();
    onEvent.onmessage = listener;
    await invoke('desktop_update_download', { onEvent });
  },
  async install() {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('desktop_update_install');
  },
  async revealApp() {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('desktop_update_reveal_app');
  },
  async currentVersion() {
    const app = await import('@tauri-apps/api/app');
    return app.getVersion();
  },
  async relaunch() {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('desktop_relaunch_after_update');
  },
};

export const desktopUpdaterController = createDesktopUpdaterController({
  adapter: tauriDesktopUpdaterAdapter,
  isTauriRuntime,
  autoDownload: readAutoUpdatePreference,
});
