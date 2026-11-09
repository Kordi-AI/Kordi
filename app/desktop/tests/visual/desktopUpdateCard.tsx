import './previewChatTheme';
import { StrictMode, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CircleHelp } from 'lucide-react';
import '../../src/index.css';
import {
  createDesktopUpdaterController,
  type DesktopUpdaterAdapter,
  type DesktopUpdaterLocation,
} from '../../src/features/updates/desktopUpdater';
import { readAutoUpdatePreference } from '../../src/features/updates/autoUpdatePreference';
import { UpdatesSettingsPanel } from '../../src/features/updates/UpdatesSettingsPanel';
import { useSidebarUpdater } from '../../src/pages/workspaceSidebar.update';

// Login-free preview of issue #2404: the real card, hook, controller and
// Settings panel, driven by a simulated update server. Nothing is installed.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const CURRENT = '0.0.2-beta.7';
const NEXT = '0.0.2-beta.8';
const TOTAL = 48 * 1024 * 1024;

type Scenario = { label: string; update: boolean; location: DesktopUpdaterLocation; failCheck?: boolean; failInstall?: boolean };
const SCENARIOS: Record<string, Scenario> = {
  newVersion: { label: 'New version', update: true, location: 'applications' },
  upToDate: { label: 'Up to date', update: false, location: 'applications' },
  outsideApplications: { label: 'Not in Applications', update: true, location: 'elsewhere' },
  offline: { label: 'Check fails', update: true, location: 'applications', failCheck: true },
  installFails: { label: 'Install fails', update: true, location: 'applications', failInstall: true },
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function simulatedAdapter(scenario: () => Scenario, log: (line: string) => void): DesktopUpdaterAdapter {
  return {
    async check() {
      await wait(700);
      const current = scenario();
      if (current.failCheck) throw new Error('The update server could not be reached.');
      return { update: current.update ? { currentVersion: CURRENT, version: NEXT } : null, location: current.location };
    },
    async download(listener) {
      listener({ event: 'Started', data: { contentLength: TOTAL } });
      for (let received = 0; received < TOTAL; received += TOTAL / 24) {
        await wait(120);
        listener({ event: 'Progress', data: { chunkLength: TOTAL / 24 } });
      }
      listener({ event: 'Finished' });
      log('Downloaded in the background. Quitting now would install it in place.');
    },
    async install() {
      await wait(900);
      if (scenario().failInstall) throw new Error('The update signature could not be verified.');
      log('Installed over /Applications/Kordi.app (simulated).');
    },
    async relaunch() {
      await wait(900);
      log('Relaunch requested (simulated; this preview stays open).');
    },
    async revealApp() {
      log('Show in Finder requested (simulated).');
    },
    async currentVersion() {
      return CURRENT;
    },
  };
}

let activeScenario = SCENARIOS.newVersion;
const eventListeners = new Set<(line: string) => void>();
const controller = createDesktopUpdaterController({
  adapter: simulatedAdapter(() => activeScenario, (line) => eventListeners.forEach((listener) => listener(line))),
  isTauriRuntime: () => true,
  autoDownload: readAutoUpdatePreference,
});

function Preview() {
  const [scenarioKey, setScenarioKey] = useState('newVersion');
  const [events, setEvents] = useState<string[]>([]);
  const [tab, setTab] = useState<'app' | 'settings'>('app');
  useEffect(() => {
    const listener = (line: string) => setEvents((list) => [line, ...list].slice(0, 4));
    eventListeners.add(listener);
    return () => { eventListeners.delete(listener); };
  }, []);

  useLayoutEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, []);

  const { menuAction, popover } = useSidebarUpdater({
    isNativeShell: true,
    onCheckForUpdates: controller.check,
    onInstallUpdate: controller.install,
    onRetryUpdate: controller.retry,
    onSubscribeToUpdate: controller.subscribe,
    onOpenUpdateUrl: () => setEvents((list) => ['Download manually opened (simulated).', ...list].slice(0, 4)),
    onRevealUpdateApp: controller.revealApp,
  });

  return (
    <div className={`kordi-app theme-${theme} flex h-screen`} style={{ background: 'var(--app-main-bg)', color: 'var(--app-transient-text)' }}>
      <div className="app-left-glass flex w-[56px] shrink-0 flex-col items-center justify-end gap-2 pb-3">
        {popover}
        <button data-help-target="help" type="button" className="app-workspace-nav-button relative grid h-8 w-8 place-items-center rounded-[10px] p-0" aria-label="Help" title={menuAction?.label} onClick={() => menuAction?.onClick({} as never)}>
          <CircleHelp className="h-[18px] w-[18px]" aria-hidden="true" />
          {menuAction?.updateAvailable ? <span className="absolute right-0 top-0 h-2 w-2 rounded-full bg-red-500" aria-hidden="true" /> : null}
        </button>
      </div>
      <main className="flex min-w-0 flex-1 flex-col gap-4 p-6 text-[12px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="opacity-60">Server</span>
          {Object.entries(SCENARIOS).map(([key, scenario]) => (
            <button key={key} type="button" className="app-button-quiet rounded-lg px-2.5 py-1" aria-pressed={key === scenarioKey} style={{ fontWeight: key === scenarioKey ? 600 : 400 }} onClick={() => { activeScenario = SCENARIOS[key]; setScenarioKey(key); }}>{scenario.label}</button>
          ))}
          <button type="button" className="app-button-primary rounded-lg px-3 py-1.5" onClick={() => { void controller.check(); }}>Run launch check</button>
          <button type="button" className="app-button-quiet rounded-lg px-2.5 py-1" onClick={() => { localStorage.removeItem('kordi.desktop-update-card-dismissed.v1'); location.reload(); }}>Reset</button>
          <span className="opacity-60">· Help button: {menuAction?.label}</span>
        </div>
        <div className="flex gap-2">
          <button type="button" className="app-button-quiet rounded-lg px-2.5 py-1" aria-pressed={tab === 'app'} onClick={() => setTab('app')}>Workspace</button>
          <button type="button" className="app-button-quiet rounded-lg px-2.5 py-1" aria-pressed={tab === 'settings'} onClick={() => setTab('settings')}>Settings › Updates</button>
        </div>
        {tab === 'settings' ? (
          <div className="app-transient-surface app-modal-panel app-cloud-account-settings-dialog w-[min(620px,100%)] rounded-[12px]">
            <div className="app-main-panel app-cloud-account-settings-page px-8 pb-8 pt-8">
              <UpdatesSettingsPanel bridge={{
                check: controller.check,
                downloadInBackground: controller.downloadInBackground,
                getState: controller.getState,
                subscribe: controller.subscribe,
                appVersion: async () => CURRENT,
              }} />
            </div>
          </div>
        ) : null}
        <ul className="m-0 list-none p-0 opacity-70">{events.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Preview /></StrictMode>);
