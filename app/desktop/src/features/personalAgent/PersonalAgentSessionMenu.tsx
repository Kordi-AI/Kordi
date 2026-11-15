import { Bell, BellOff, CheckCircle2, Download, Mail } from 'lucide-react';
import type { SessionActionTarget, SessionContextMenuTarget } from '@/pages/SessionActionOverlays';

const ROW_CLASS = 'app-dense-menu-row';

/**
 * The context menu of a personal session. It is never renamed, pinned,
 * moved, archived or deleted; its read state and mute change here, and its
 * trace can be exported.
 */
export function PersonalAgentSessionMenu({
  target, onClose, onSetMuted, onSetUnread, onExport,
}: {
  target: SessionContextMenuTarget & { personalAgent: NonNullable<SessionContextMenuTarget['personalAgent']> };
  onClose: () => void;
  onSetMuted: (sessionId: string, muted: boolean) => void;
  onSetUnread: (sessionId: string, unread: boolean) => void;
  onExport: (target: SessionActionTarget) => void;
}) {
  const run = (action: () => void) => {
    onClose();
    action();
  };
  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        role="menu"
        aria-label={`${target.sessionName} actions`}
        className="app-transient-surface app-dense-menu app-context-menu absolute"
        style={{
          left: Math.max(12, Math.min(target.x, window.innerWidth - 232)),
          top: Math.max(12, Math.min(target.y, window.innerHeight - 148)),
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" role="menuitem" data-session-context-action={target.unread ? 'read' : 'unread'} className={ROW_CLASS}
          onClick={() => run(() => onSetUnread(target.sessionId, !target.unread))}>
          {target.unread
            ? <CheckCircle2 aria-hidden="true" />
            : <Mail aria-hidden="true" />}
          {target.unread ? 'Mark as read' : 'Mark as unread'}
        </button>
        <button type="button" role="menuitem" data-session-context-action="mute" className={ROW_CLASS}
          onClick={() => run(() => onSetMuted(target.sessionId, !target.muted))}>
          {target.muted
            ? <Bell aria-hidden="true" />
            : <BellOff aria-hidden="true" />}
          {target.muted ? 'Unmute' : 'Mute'}
        </button>
        <button type="button" role="menuitem" data-session-context-action="export" className={ROW_CLASS}
          onClick={() => run(() => onExport({ sessionId: target.sessionId, sessionName: target.sessionName }))}>
          <Download aria-hidden="true" />
          Export
        </button>
      </div>
    </div>
  );
}
