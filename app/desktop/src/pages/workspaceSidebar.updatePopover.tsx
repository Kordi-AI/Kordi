import type { RefObject } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopUpdaterState } from '@/features/updates/desktopUpdater';

function formatUpdateBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type SidebarUpdateCardActions = {
  onClose: () => void;
  onConfirm: () => void;
  onOpenUrl?: (url: string) => Promise<void> | void;
  onRevealApp?: () => Promise<void> | void;
};

type CardAction = { label: string; onClick: () => void; disabled?: boolean };

export type UpdateCardContent = {
  title: string;
  copy?: string;
  progress?: boolean;
  primary?: CardAction;
  secondary?: CardAction;
};

/** Title, one line and up to two actions for each update state. */
function updateCardContent(
  state: DesktopUpdaterState,
  { onClose, onConfirm, onOpenUrl, onRevealApp }: SidebarUpdateCardActions,
  canInstall: boolean,
): UpdateCardContent {
  const version = state.latestVersion ? `Kordi ${state.latestVersion}` : 'New Kordi';
  const notNow = { label: 'Not now', onClick: onClose };
  const close = { label: 'Close', onClick: onClose };
  switch (state.status) {
    case 'ready':
      return { title: version, copy: 'Restart to finish updating.', primary: { label: 'Restart to update', onClick: onConfirm, disabled: !canInstall }, secondary: notNow };
    case 'available':
      return { title: version, copy: 'A new version is available.', primary: { label: 'Update now', onClick: onConfirm, disabled: !canInstall }, secondary: notNow };
    case 'downloading':
      return { title: 'Updating Kordi', progress: true };
    case 'installing':
      return { title: 'Installing update', copy: 'Kordi restarts when it finishes.' };
    case 'relaunching':
      return { title: 'Restarting Kordi', copy: 'Kordi reopens in a moment.' };
    case 'checking':
      return { title: 'Checking for updates', progress: true };
    case 'misplaced':
      return {
        title: 'Move Kordi to Applications',
        copy: 'Kordi can only update itself from there.',
        primary: onRevealApp ? { label: 'Show in Finder', onClick: () => { void onRevealApp(); } } : undefined,
        secondary: notNow,
      };
    case 'failed': {
      const manual = state.manualDownloadUrl;
      const secondary = manual && onOpenUrl
        ? { label: 'Download manually', onClick: () => { void onOpenUrl(manual); } }
        : close;
      return state.failureStage === 'check'
        ? { title: 'Couldn’t check for updates', copy: 'Check your connection and try again.', primary: { label: 'Try again', onClick: onConfirm }, secondary }
        : { title: 'Couldn’t update Kordi', copy: 'Your current version still works.', primary: { label: 'Try again', onClick: onConfirm }, secondary };
    }
    default:
      return {
        title: 'Kordi is up to date',
        copy: state.currentVersion ? `Version ${state.currentVersion}` : undefined,
        secondary: close,
      };
  }
}

function UpdateProgress({ state }: { state: DesktopUpdaterState }) {
  const total = state.status === 'downloading' && typeof state.totalBytes === 'number' && state.totalBytes > 0
    ? state.totalBytes
    : null;
  const percent = total ? Math.round(Math.min(100, ((state.receivedBytes ?? 0) / total) * 100)) : null;
  return (
    <>
      <div
        className="app-update-card-track mt-3 h-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-label={state.status === 'checking' ? 'Checking for updates' : 'Update download progress'}
        aria-valuemin={percent === null ? undefined : 0}
        aria-valuemax={percent === null ? undefined : 100}
        aria-valuenow={percent ?? undefined}
      >
        <div
          className="app-update-card-fill h-full rounded-full"
          data-indeterminate={percent === null ? 'true' : undefined}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {total ? (
        <div className="app-update-card-meta mt-1.5 text-[11px] tabular-nums">
          {`${formatUpdateBytes(state.receivedBytes ?? 0)} of ${formatUpdateBytes(total)}`}
        </div>
      ) : null}
    </>
  );
}

type SidebarUpdatePopoverProps = SidebarUpdateCardActions & {
  anchor: { left: number; bottom: number } | null;
  popoverRef: RefObject<HTMLDivElement | null>;
  state: DesktopUpdaterState;
  canInstall: boolean;
};

/** The update card, laid out like the Kordi for Mac prompt beside the Help button. */
export function SidebarUpdatePopover({
  anchor,
  popoverRef,
  state,
  canInstall,
  ...actions
}: SidebarUpdatePopoverProps) {
  if (!anchor || typeof document === 'undefined') return null;
  const content = updateCardContent(state, actions, canInstall);
  const hasActions = Boolean(content.primary || content.secondary);

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Kordi update"
      style={{ left: anchor.left, bottom: anchor.bottom }}
      className="app-transient-surface app-update-card fixed z-[180] w-60 rounded-xl border p-4 text-left text-foreground"
      data-update-state={state.status}
    >
      <p className="m-0 text-[13px] font-semibold">{content.title}</p>
      {content.copy ? (
        <p
          role={state.status === 'failed' ? 'alert' : 'status'}
          className={hasActions ? 'my-2 text-[12px] leading-5' : 'mb-0 mt-2 text-[12px] leading-5'}
        >
          {content.copy}
        </p>
      ) : null}
      {content.progress ? <UpdateProgress state={state} /> : null}
      {hasActions ? (
        <div className="flex items-center gap-3">
          {content.primary ? (
            <button
              type="button"
              className="app-button-primary rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-55"
              disabled={content.primary.disabled}
              onClick={content.primary.onClick}
            >
              {content.primary.label}
            </button>
          ) : null}
          {content.secondary ? (
            <button type="button" className="text-xs" onClick={content.secondary.onClick}>
              {content.secondary.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>,
    document.querySelector('.kordi-app') ?? document.body,
  );
}
