import { BellOff } from 'lucide-react';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { cn } from '@/lib/utils';
import type { SessionContextMenuTarget } from '@/pages/SessionActionOverlays';
import { participantSpaceSessionPreferenceId, participantSpaceSessionPreviewText } from '@/pages/workspaceSidebar.chatHelpers';
import type { WorkspaceChatSidebarModel } from '@/pages/workspaceSidebar.chatModel';
import { SidebarPreviewText } from '@/pages/workspaceSidebar.chatPrimitives';
import { SidebarSessionMetaColumn } from '@/pages/workspaceSidebar.shared';
import type { PersonalAgentEntry } from './personalAgentStore';

type SidebarSessionRow = NonNullable<ReturnType<WorkspaceChatSidebarModel['allSidebarSessionRowsById']['get']>>;

/**
 * One owned agent's always-online session under the Personal agent entry,
 * laid out like Saved messages: avatar, name, latest message. Its menu
 * changes only read state and mute.
 */
export function PersonalAgentSidebarRow({
  entry, row, model, activeConvId, onSelectChatSession, onOpenSessionContextMenu,
}: {
  entry?: PersonalAgentEntry;
  /** The local session, once this Mac has it. */
  row?: SidebarSessionRow;
  model: Pick<WorkspaceChatSidebarModel, 'mutedSessionIds' | 'unreadSessionIds'>;
  activeConvId: string;
  onSelectChatSession: (sessionId: string) => void;
  onOpenSessionContextMenu: (target: SessionContextMenuTarget) => void;
}) {
  if (!entry) return null;
  const session = row?.session;
  const sessionId = session?.id ?? entry.sessionId;
  const preferenceId = session ? participantSpaceSessionPreferenceId(session) : entry.sessionId;
  const isActive = Boolean(activeConvId) && [sessionId, session?.canonicalSessionId, entry.sessionId].includes(activeConvId);
  const preview = (session ? participantSpaceSessionPreviewText(session.preview) : '') || 'No messages yet';
  const timeLabel = session && session.conversation.messages.length > 0
    ? session.updatedAtLabel ?? session.conversation.updatedAtLabel ?? ''
    : '';
  const muted = model.mutedSessionIds.has(preferenceId);
  const unread = Math.max(model.unreadSessionIds.has(preferenceId) ? 1 : 0, session?.unread ?? 0);
  return (
    <button
      type="button"
      data-testid="personal-agent-row"
      data-personal-agent-row={entry.agentId}
      data-session-sidebar-section="personal"
      data-session-preview={preview}
      aria-label={`${entry.name}, Online${unread > 0 ? ', unread' : ''}${muted ? ', muted' : ''}. ${preview}`}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'app-session-row app-agent-session-row app-personal-agent-row w-full px-2.5 py-1 text-left text-white',
        isActive && 'app-session-row-active',
      )}
      onClick={() => onSelectChatSession(sessionId)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenSessionContextMenu({
          sessionId: preferenceId, sessionName: entry.name, x: event.clientX, y: event.clientY, canRename: false,
          ...(muted ? { muted: true } : {}), ...(unread > 0 ? { unread: true } : {}),
          personalAgent: { agentId: entry.agentId },
        });
      }}
    >
      <IdentityAvatar
        kind="agent"
        seed={entry.avatarSeed}
        name={entry.name}
        imageUrl={entry.profileImageUrl}
        className="h-9 w-9"
        presenceStatus="online"
        presenceLabel="Online"
      />
      <div className="app-agent-session-main min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="app-session-row-title min-w-0 truncate text-[12px] font-semibold tracking-[-0.01em] text-slate-100" title={entry.name}>
            {entry.name}
          </span>
          {muted ? <BellOff className="h-3 w-3 shrink-0 text-slate-400" aria-label="Muted" /> : null}
        </div>
        <div className={cn(
          'app-agent-session-preview mt-0.5 flex min-w-0 items-center gap-1 text-[10.5px] leading-[1rem]',
          isActive ? 'text-slate-300' : 'text-slate-500',
          session?.statusIndicator?.live && 'app-participant-space-session-preview-live',
        )}>
          <span className="min-w-0 truncate">
            {session ? <SidebarPreviewText text={preview} conversations={[session.conversation]} /> : preview}
          </span>
        </div>
      </div>
      <div className="app-agent-session-side">
        <SidebarSessionMetaColumn
          timeLabel={timeLabel}
          unreadCount={unread}
          unreadScope="agent-session"
          indicator={session?.statusIndicator}
          active={isActive}
          reserveStatusSpace={false}
          muted={muted}
        />
      </div>
    </button>
  );
}
