import { isClosedConversation, isClosedParticipantSpace } from '@/features/chat/closedGroup';
import type { ParticipantSpaceViewModel } from '@/kordi-app/types';
import { ClosedConversationBar } from '@/pages/ClosedConversationBar';

/**
 * The bar that replaces the composer when the open chat is closed, or null
 * while it is open.
 */
export function closedConversationComposer(
  conversation: {
    id: string;
    name: string;
    canonicalSessionId?: string | null;
    participantSpaceId?: string | null;
    metadata?: unknown;
  },
  session: {
    participantSpaces: Pick<ParticipantSpaceViewModel, 'id' | 'kind' | 'sessions'>[];
    onDeleteChatSession?: (sessionId: string) => Promise<void>;
  },
) {
  if (!isClosedConversation(conversation)) return null;
  const space = session.participantSpaces.find((candidate) => candidate.id === conversation.participantSpaceId);
  return (
    <ClosedConversationBar
      sessionId={conversation.canonicalSessionId ?? conversation.id}
      sessionName={conversation.name}
      groupClosed={!space || isClosedParticipantSpace(space)}
      onDelete={session.onDeleteChatSession}
    />
  );
}
