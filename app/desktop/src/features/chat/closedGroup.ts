import { CloudAuthError } from '@/features/cloud/cloudAuthError';
import type { CanonicalSessionState, ParticipantSpaceViewModel } from '@/kordi-app/types';

/**
 * A closed group or channel keeps its members and history, and nothing new is
 * written there. The server marks each conversation with `closed`; the desktop
 * keeps the time on the canonical session's metadata under this key.
 */
export const GROUP_CLOSED_AT_METADATA_KEY = 'groupClosedAt';

/** The server's refusal of a write to a closed conversation. */
export const GROUP_CLOSED_ERROR_CODE = 'group_closed';

export const GROUP_CLOSED_SEND_FAILURE = 'This group was closed.';

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

/** The time a session was closed, from its metadata, or null while it is open. */
export function closedAtFromMetadata(metadata: unknown): string | null {
  const value = metadataRecord(metadata)[GROUP_CLOSED_AT_METADATA_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function isClosedConversation(conversation: { metadata?: unknown } | null | undefined): boolean {
  return Boolean(conversation && closedAtFromMetadata(conversation.metadata));
}

function metadataGroupSpaceId(metadata: unknown) {
  const record = metadataRecord(metadata);
  const value = [record.groupSpaceId, record.groupId].find(
    (candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()),
  );
  return value ? value.trim().replace(/^(?:group:)+/, '') : '';
}

function sessionKey(session: { id?: string | null; canonicalSessionId?: string | null }) {
  return (session.canonicalSessionId || session.id || '').trim();
}

/**
 * A group row reads as closed when its first chat (the group itself) is
 * closed, or when every chat it lists is closed.
 */
export function isClosedParticipantSpace(
  space: Pick<ParticipantSpaceViewModel, 'id' | 'kind' | 'sessions'> | null | undefined,
): boolean {
  if (!space || space.kind !== 'group' || space.sessions.length === 0) return false;
  const groupSpaceId = space.id.trim().replace(/^(?:group:)+/, '');
  const root = space.sessions.find((session) => sessionKey(session) === groupSpaceId);
  if (root) return isClosedConversation(root.conversation);
  return space.sessions.every((session) => isClosedConversation(session.conversation));
}

/** Copies `metadata` with the closed time set; an earlier stored time wins. */
export function metadataWithClosedAt(metadata: unknown, closedAt: string): Record<string, unknown> {
  const record = { ...metadataRecord(metadata) };
  if (!closedAtFromMetadata(record)) record[GROUP_CLOSED_AT_METADATA_KEY] = closedAt;
  return record;
}

/** Marks the given sessions closed in memory. Returns `state` itself when nothing changes. */
export function canonicalStateWithClosedSessions(
  state: CanonicalSessionState | null,
  sessionIds: readonly string[],
  closedAt: string,
): CanonicalSessionState | null {
  if (!state) return state;
  const ids = new Set(sessionIds.map((id) => id.trim()).filter(Boolean));
  let changed = false;
  const sessions = state.sessions.map((session) => {
    if (!ids.has(session.id) || closedAtFromMetadata(session.metadata)) return session;
    changed = true;
    return { ...session, metadata: metadataWithClosedAt(session.metadata, closedAt) };
  });
  return changed ? { ...state, sessions } : state;
}

/**
 * Where a session sits among closed chats: its group, every chat of that group
 * known here, and whether the group itself (its first chat) is closed.
 */
export function closedGroupScope(state: CanonicalSessionState | null, sessionId: string) {
  const id = sessionId.trim();
  const session = state?.sessions.find((candidate) => candidate.id === id) ?? null;
  const groupSpaceId = metadataGroupSpaceId(session?.metadata) || id;
  const groupSessionIds = (state?.sessions ?? [])
    .filter((candidate) => candidate.kind === 'group'
      && (candidate.id === groupSpaceId || metadataGroupSpaceId(candidate.metadata) === groupSpaceId))
    .map((candidate) => candidate.id);
  const root = state?.sessions.find((candidate) => candidate.id === groupSpaceId) ?? null;
  const groupSessions = (state?.sessions ?? []).filter((candidate) => groupSessionIds.includes(candidate.id));
  const groupClosed = root
    ? Boolean(closedAtFromMetadata(root.metadata))
    : groupSessions.length > 0 && groupSessions.every((candidate) => closedAtFromMetadata(candidate.metadata));
  return {
    groupSpaceId,
    groupSessionIds: groupSessionIds.length > 0 ? groupSessionIds : [id],
    sessionClosed: Boolean(closedAtFromMetadata(session?.metadata)),
    groupClosed,
  };
}

/** After a send the server refused as closed, shows the session closed here at once. */
export function closeSessionAfterGroupSendFailure(
  error: unknown,
  sessionId: string,
  setState: (update: (current: CanonicalSessionState | null) => CanonicalSessionState | null) => void,
): void {
  if (!isGroupClosedError(error) || !sessionId.trim()) return;
  const closedAt = new Date().toISOString();
  setState((current) => canonicalStateWithClosedSessions(current, [sessionId], closedAt));
}

/** Whether a write failed because the server says the conversation is closed. */
export function isGroupClosedError(error: unknown): boolean {
  if (error instanceof CloudAuthError) return error.serverCode === GROUP_CLOSED_ERROR_CODE;
  return Boolean(error && typeof error === 'object'
    && (error as { serverCode?: unknown }).serverCode === GROUP_CLOSED_ERROR_CODE);
}
