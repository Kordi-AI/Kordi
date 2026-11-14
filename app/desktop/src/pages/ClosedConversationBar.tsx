import { useState } from 'react';

import { DeleteSessionDialog, type SessionActionTarget } from '@/pages/SessionActionOverlays';

function closedConversationLine(groupClosed: boolean) {
  return groupClosed ? 'This group was closed' : 'This channel was closed';
}

/** Replaces the composer of a closed group or channel; the history above stays readable. */
export function ClosedConversationBar({
  sessionId,
  sessionName,
  groupClosed,
  onDelete,
}: {
  sessionId: string;
  sessionName: string;
  /** The whole group was closed, not only this channel: Delete chat leaves it. */
  groupClosed: boolean;
  onDelete?: (sessionId: string) => Promise<void>;
}) {
  const [target, setTarget] = useState<SessionActionTarget | null>(null);
  return (
    <div className="app-chat-composer-frame shrink-0 px-5 pb-4 pt-3">
      <div className="app-closed-conversation-bar" data-closed-conversation-bar="true">
        <span>{closedConversationLine(groupClosed)}</span>
        {onDelete ? (
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
      {target && onDelete ? (
        <DeleteSessionDialog target={target} onCancel={() => setTarget(null)} onConfirm={onDelete} />
      ) : null}
    </div>
  );
}
