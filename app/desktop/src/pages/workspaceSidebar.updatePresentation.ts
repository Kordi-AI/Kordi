import type { DesktopUpdaterState } from '@/features/updates/desktopUpdater';

const TITLES: Partial<Record<DesktopUpdaterState['status'], string>> = {
  available: 'Update available',
  ready: 'Restart to update',
  misplaced: 'Move Kordi to Applications',
  checking: 'Checking for updates…',
  downloading: 'Downloading update…',
  installing: 'Installing update…',
  relaunching: 'Restarting Kordi…',
};

export function desktopUpdateButtonPresentation(state: DesktopUpdaterState) {
  const title = state.status === 'failed' && state.failureStage === 'install'
    ? 'Retry update'
    : TITLES[state.status] ?? 'Check for updates';
  return { title };
}
