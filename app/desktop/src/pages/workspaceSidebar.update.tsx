import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useAutoUpdatePreference } from '@/features/updates/autoUpdatePreference';
import type { DesktopUpdaterState } from '@/features/updates/desktopUpdater';
import { SidebarUpdatePopover } from '@/pages/workspaceSidebar.updatePopover';
import { desktopUpdateButtonPresentation } from '@/pages/workspaceSidebar.updatePresentation';

export type SidebarUpdaterProps = {
  isNativeShell: boolean;
  onCheckForUpdates?: () => Promise<DesktopUpdaterState>;
  onInstallUpdate?: () => Promise<void>;
  onRetryUpdate?: () => Promise<void | DesktopUpdaterState>;
  onSubscribeToUpdate?: (listener: (state: DesktopUpdaterState) => void) => () => void;
  onOpenUpdateUrl?: (url: string) => Promise<void> | void;
  onRevealUpdateApp?: () => Promise<void> | void;
};

/** Rechecks while Kordi stays open, so long sessions still see new versions. */
export const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CARD_WIDTH = 240;
const DISMISSED_KEY = 'kordi.desktop-update-card-dismissed.v1';

/** The card opens on its own once per version for these states. */
export function updateCardPromptKey(state: DesktopUpdaterState, autoUpdate: boolean) {
  if (!state.latestVersion) return null;
  if (state.status === 'ready' || state.status === 'misplaced') return `${state.status}:${state.latestVersion}`;
  if (state.status === 'available' && !autoUpdate) return `available:${state.latestVersion}`;
  return null;
}

function readDismissedPrompt() {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function saveDismissedPrompt(key: string) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, key);
  } catch {
    // Dismissal still holds until Kordi restarts.
  }
}

/** Places the card beside the Help button, like the Kordi for Mac prompt. */
export function helpCornerAnchor(): { left: number; bottom: number } {
  const rect = document.querySelector('[data-help-target="help"]')?.getBoundingClientRect();
  if (!rect || rect.width === 0) return { left: 64, bottom: 12 };
  return {
    left: Math.max(8, Math.min(rect.right + 12, window.innerWidth - CARD_WIDTH - 8)),
    bottom: Math.max(8, Math.min(window.innerHeight - rect.bottom, window.innerHeight - 200)),
  };
}

export function useSidebarUpdater({
  isNativeShell,
  onCheckForUpdates,
  onInstallUpdate,
  onRetryUpdate,
  onSubscribeToUpdate,
  onOpenUpdateUrl,
  onRevealUpdateApp,
}: SidebarUpdaterProps) {
  const autoUpdate = useAutoUpdatePreference();
  const updatePopoverRef = useRef<HTMLDivElement | null>(null);
  const updateCheckPromiseRef = useRef<Promise<DesktopUpdaterState> | null>(null);
  const [updateState, setUpdateState] = useState<DesktopUpdaterState>({ status: 'idle' });
  const updateStateRef = useRef<DesktopUpdaterState>({ status: 'idle' });
  const [isCardOpen, setIsCardOpen] = useState(false);
  const [cardAnchor, setCardAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const shownPromptRef = useRef<string | null>(null);
  const buttonPresentation = desktopUpdateButtonPresentation(updateState);

  const applyUpdateState = useCallback((nextState: DesktopUpdaterState) => {
    updateStateRef.current = nextState;
    setUpdateState(nextState);
  }, []);

  useEffect(() => {
    if (!onSubscribeToUpdate) return;
    return onSubscribeToUpdate(applyUpdateState);
  }, [applyUpdateState, onSubscribeToUpdate]);

  const runUpdateCheck = useCallback(() => {
    if (!isNativeShell || !onCheckForUpdates) {
      return Promise.resolve<DesktopUpdaterState>({ status: 'idle' });
    }
    if (updateCheckPromiseRef.current) return updateCheckPromiseRef.current;

    const pending = onCheckForUpdates()
      .then((result) => {
        applyUpdateState(result);
        return result;
      })
      .catch((error) => {
        const failed: DesktopUpdaterState = {
          ...updateStateRef.current,
          status: 'failed',
          failureStage: 'check',
          error: error instanceof Error && error.message.trim()
            ? error.message
            : 'Unable to check for Kordi updates. Check your connection and try again.',
        };
        applyUpdateState(failed);
        return failed;
      })
      .finally(() => {
        if (updateCheckPromiseRef.current === pending) {
          updateCheckPromiseRef.current = null;
        }
      });
    updateCheckPromiseRef.current = pending;
    return pending;
  }, [applyUpdateState, isNativeShell, onCheckForUpdates]);

  // Check at launch, then periodically while the app stays open.
  useEffect(() => {
    if (!isNativeShell || !onCheckForUpdates) return;
    let active = true;
    queueMicrotask(() => {
      if (active) void runUpdateCheck();
    });
    const interval = window.setInterval(() => {
      const status = updateStateRef.current.status;
      if (status === 'idle' || status === 'up-to-date' || status === 'available' || status === 'ready'
        || status === 'misplaced' || (status === 'failed' && updateStateRef.current.failureStage === 'check')) {
        void runUpdateCheck();
      }
    }, UPDATE_RECHECK_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [isNativeShell, onCheckForUpdates, runUpdateCheck]);

  // Open the card on its own once per version when there is something to do.
  const promptKey = updateCardPromptKey(updateState, autoUpdate);
  useEffect(() => {
    if (!promptKey || shownPromptRef.current === promptKey || readDismissedPrompt() === promptKey) return;
    shownPromptRef.current = promptKey;
    setCardAnchor(helpCornerAnchor());
    setIsCardOpen(true);
  }, [promptKey]);

  const dismissCard = useCallback(() => {
    const key = updateCardPromptKey(updateStateRef.current, autoUpdate);
    if (key) saveDismissedPrompt(key);
    setIsCardOpen(false);
  }, [autoUpdate]);

  useEffect(() => {
    if (!isCardOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || updatePopoverRef.current?.contains(target)) return;
      // Clicking elsewhere only hides the card; it does not count as "Not now".
      setIsCardOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsCardOpen(false);
    };
    const onResize = () => setCardAnchor(helpCornerAnchor());
    window.addEventListener('resize', onResize);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isCardOpen]);

  const handleUpdateButtonClick = () => {
    setCardAnchor(helpCornerAnchor());
    setIsCardOpen(true);
    const { status, failureStage } = updateStateRef.current;
    if (status === 'idle' || status === 'up-to-date' || (status === 'failed' && failureStage === 'check')) {
      void runUpdateCheck();
    }
  };

  const handleConfirmUpdate = async () => {
    const current = updateStateRef.current;
    if (current.status === 'failed' && current.failureStage === 'check') {
      await runUpdateCheck();
      return;
    }
    const action = current.status === 'failed'
      ? (onRetryUpdate ?? onInstallUpdate)
      : onInstallUpdate;
    if (!action) return;
    try {
      const result = await action();
      if (result) applyUpdateState(result);
    } catch (error) {
      if (updateStateRef.current.status === 'failed') return;
      applyUpdateState({
        ...updateStateRef.current,
        status: 'failed',
        failureStage: 'install',
        error: error instanceof Error ? error.message : 'Unable to install update',
      });
    }
  };

  const enabled = isNativeShell && Boolean(onCheckForUpdates);
  const { status } = updateState;
  return {
    menuAction: enabled ? {
      updateAvailable: status === 'available' || status === 'ready' || status === 'misplaced',
      label: buttonPresentation.title,
      onClick: handleUpdateButtonClick,
    } : undefined,
    popover: enabled && isCardOpen ? (
      <SidebarUpdatePopover
        anchor={cardAnchor}
        popoverRef={updatePopoverRef}
        state={updateState}
        canInstall={Boolean(onInstallUpdate)}
        onClose={dismissCard}
        onConfirm={() => {
          void handleConfirmUpdate();
        }}
        onOpenUrl={onOpenUpdateUrl}
        onRevealApp={onRevealUpdateApp}
      />
    ) : null,
  };
}
