import type { CanonicalSession, Conversation, Message } from '@/kordi-app/types';
import { traceMessageSender, type SessionTraceInput, type SessionTraceParticipant } from './serializeSessionTrace';

/** Participants as the chat header lists them, or the transcript's senders when it lists none. */
export function sessionTraceParticipants(
  conversation: Pick<Conversation, 'canonicalParticipants'> | null | undefined,
  messages: readonly Message[],
  viewer: Pick<SessionTraceInput, 'exportedBy' | 'viewerIdentityId'>,
): SessionTraceParticipant[] {
  const listed = conversation?.canonicalParticipants ?? [];
  if (listed.length) {
    return listed.map((participant) => ({
      id: participant.id,
      name: participant.name,
      kind: participant.kind === 'agent' ? 'agent' : 'human',
      role: participant.role,
      ownerId: participant.ownerIdentityId ?? null,
    }));
  }
  const byId = new Map<string, SessionTraceParticipant>();
  for (const message of messages) {
    const sender = traceMessageSender(message, viewer);
    if (sender.kind === 'system' || byId.has(sender.id)) continue;
    byId.set(sender.id, { id: sender.id, name: sender.name, kind: sender.kind });
  }
  return [...byId.values()];
}

export function sessionTraceSessionInfo({
  sessionId,
  title,
  canonicalSession,
  conversation,
  runtime,
}: {
  sessionId: string;
  title: string;
  canonicalSession?: CanonicalSession | null;
  conversation?: Pick<Conversation, 'type' | 'canonicalCreatedAtMs'> | null;
  runtime: boolean;
}): SessionTraceInput['session'] {
  return {
    id: sessionId,
    kind: canonicalSession?.kind || (runtime ? 'self-agent' : conversation?.type) || 'session',
    title: title.trim() || canonicalSession?.title || 'Untitled',
    createdAtMs: canonicalSession?.createdAtMs ?? conversation?.canonicalCreatedAtMs ?? null,
    project: canonicalSession?.projectName ?? null,
  };
}
