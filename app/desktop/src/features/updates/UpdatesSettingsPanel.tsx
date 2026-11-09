import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SettingsRow, SettingsSection, SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { checkDesktopForUpdates, subscribeDesktopUpdater } from '@/lib/desktop';
import { setAutoUpdatePreference, useAutoUpdatePreference } from './autoUpdatePreference';
import { desktopUpdaterController, type DesktopUpdaterState } from './desktopUpdater';

function checkStatusLine(state: DesktopUpdaterState) {
  const next = state.latestVersion ? `Kordi ${state.latestVersion}` : 'A new version';
  if (state.status === 'checking') return 'Checking…';
  if (state.status === 'up-to-date') return 'Kordi is up to date.';
  if (state.status === 'available' || state.status === 'downloading') return `${next} is available.`;
  if (state.status === 'ready') return `${next} installs when Kordi restarts.`;
  if (state.status === 'misplaced') return 'Move Kordi to Applications to update it.';
  if (state.status === 'failed' && state.failureStage === 'check') return 'Couldn’t check for updates.';
  return undefined;
}

export type UpdatesSettingsBridge = {
  check: () => Promise<DesktopUpdaterState>;
  downloadInBackground: () => Promise<void>;
  getState: () => DesktopUpdaterState;
  subscribe: (listener: (state: DesktopUpdaterState) => void) => () => void;
  appVersion: () => Promise<string>;
};

const desktopBridge: UpdatesSettingsBridge = {
  check: checkDesktopForUpdates,
  downloadInBackground: () => desktopUpdaterController.downloadInBackground(),
  getState: () => desktopUpdaterController.getState(),
  subscribe: subscribeDesktopUpdater,
  appVersion: () => import('@tauri-apps/api/app').then((app) => app.getVersion()),
};

/** Mac-only Settings › Updates: version, automatic updates and a manual check. */
export function UpdatesSettingsPanel({ bridge = desktopBridge }: { bridge?: UpdatesSettingsBridge }) {
  const autoUpdate = useAutoUpdatePreference();
  const [state, setState] = useState<DesktopUpdaterState>(bridge.getState);
  const [version, setVersion] = useState<string | undefined>(state.currentVersion);

  useEffect(() => {
    const unsubscribe = bridge.subscribe(setState);
    return () => { unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    let active = true;
    void bridge.appVersion()
      .then((value) => { if (active) setVersion(value); })
      .catch(() => {});
    return () => { active = false; };
  }, [bridge]);

  const busy = state.status === 'checking' || state.status === 'downloading'
    || state.status === 'installing' || state.status === 'relaunching';

  return (
    <SettingsSection title="Updates">
      <SettingsRow title="Version" control={<span className="tabular-nums">{version ?? state.currentVersion ?? '—'}</span>} />
      <SettingsRow
        title="Automatic updates"
        control={(
          <SettingsSwitch
            enabled={autoUpdate}
            label="Automatic updates"
            onChange={(enabled) => {
              setAutoUpdatePreference(enabled);
              if (enabled) void bridge.downloadInBackground();
            }}
          />
        )}
      />
      <SettingsRow
        title="Check for updates"
        description={<span aria-live="polite">{checkStatusLine(state)}</span>}
        control={(
          <Button
            type="button"
            variant="quiet"
            className="h-8 shrink-0 rounded-lg px-3.5 text-[12px]"
            disabled={busy}
            onClick={() => { void bridge.check(); }}
          >
            Check now
          </Button>
        )}
      />
    </SettingsSection>
  );
}
