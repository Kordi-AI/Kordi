import { useState } from 'react';

import { PEER_ACCOUNT_DELETED_LINE } from '@/features/chat/closedGroup';
import { DeleteSessionDialog, type SessionActionTarget } from '@/pages/SessionActionOverlays';

function closedConversationLine(groupClosed: boolean) {
  return groupClosed ? 'This group was closed' : 'This channel was closed';
}

/** Replaces the composer of a closed chat; the history above stays readable. */
export function ClosedConversationBar({
  sessionId,
  sessionName,
  groupClosed,
  peerAccountDeleted = false,
  onDelete,
}: {
  sessionId: string;
  sessionName: string;
  /** The whole group was closed, not only this channel: Delete chat leaves it. */
  groupClosed: boolean;
  /** A direct chat closed because the other account was deleted: one line, nothing else. */
  peerAccountDeleted?: boolean;
  onDelete?: (sessionId: string) => Promise<void>;
}) {
  const [target, setTarget] = useState<SessionActionTarget | null>(null);
  const canDelete = Boolean(onDelete) && !peerAccountDeleted;
  return (
    <div className="app-chat-composer-frame shrink-0 px-5 pb-4 pt-3">
      <div className="app-closed-conversation-bar" data-closed-conversation-bar="true">
        <span>{peerAccountDeleted ? PEER_ACCOUNT_DELETED_LINE : closedConversationLine(groupClosed)}</span>
        {canDelete ? (
          <button
            type="button"
            className="app-closed-conversation-delete"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setTarget({
                sessionId,
                sessionName,
                anchorRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                ...(groupClosed ? { closedGroup: true } : {}),
              });
            }}
          >
            Delete chat
          </button>
        ) : null}
      </div>
      {target && canDelete && onDelete ? (
        <DeleteSessionDialog target={target} onCancel={() => setTarget(null)} onConfirm={onDelete} />
      ) : null}
    </div>
  );
}
