import { messageDeliveryVisual } from '@/features/chat/deliveryStatus';
import { transcriptMessageIsOwnHuman } from '@/kordi-app/components/transcriptMessageHumanRole';
import type { ConversationParticipant, Message } from '@/kordi-app/types';

// "Seen by" for the viewer's own group messages. Readers load from the server
// each time the message menu opens; nothing is cached between openings.

/** Groups with more active members than this offer no Seen row (the server answers 409). */
export const SEEN_BY_MEMBER_LIMIT = 100;
export const SEEN_BY_PREVIEW_LIMIT = 4;
export const SEEN_BY_LIST_LIMIT = 100;

export type MessageReader = { accountId: string; readAt: string | null };
export type MessageReadersPage = { total: number; readers: MessageReader[] };
export type MessageSeenByTarget = { conversationId: string; messageId: string };
export type MessageSeenByPerson = {
  id: string;
  name: string;
  avatarSeed: string | null;
  profileImageUrl: string | null;
};

export type MessageSeenBySource = {
  activeMemberCount: number;
  person: (accountId: string) => MessageSeenByPerson;
  fetchReaders: (target: MessageSeenByTarget, limit: number) => Promise<MessageReadersPage>;
};

export type MessageReadersRequest =
  | { status: 'loading' }
  | { status: 'ready'; page: MessageReadersPage }
  | { status: 'failed' };

export type SeenRowState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'one'; reader: MessageReader }
  | { kind: 'several'; total: number; readers: MessageReader[] };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Decodes `GET .../readers`, keeping the server order. */
export function decodeMessageReadersPage(value: unknown): MessageReadersPage {
  const body = record(value);
  if (!body || !Array.isArray(body.readers)) throw new Error('The readers response is invalid.');
  const seen = new Set<string>();
  const readers = body.readers.flatMap((entry): MessageReader[] => {
    const reader = record(entry);
    const accountId = text(reader?.accountId) || text(reader?.account_id);
    if (!accountId || seen.has(accountId)) return [];
    seen.add(accountId);
    const readAt = text(reader?.readAt) || text(reader?.read_at);
    return [{ accountId, readAt: readAt && Number.isFinite(Date.parse(readAt)) ? readAt : null }];
  });
  const total = typeof body.total === 'number' && Number.isSafeInteger(body.total) && body.total >= readers.length
    ? body.total
    : readers.length;
  return { total, readers };
}

/** The server message to ask about, or null when the menu shows no Seen row. */
export function messageSeenByTarget(msg: Message, source: MessageSeenBySource | null): MessageSeenByTarget | null {
  if (!source || source.activeMemberCount > SEEN_BY_MEMBER_LIMIT) return null;
  if (!transcriptMessageIsOwnHuman(msg) || msg.callActivity) return null;
  const visual = messageDeliveryVisual(msg.statusChips?.[0]);
  if (visual && (visual.glyph === 'clock' || visual.tone === 'red')) return null;
  const conversationId = msg.reactionConversationId?.trim() ?? '';
  const messageId = msg.reactionTargetMessageId?.trim() ?? '';
  // A local session id means the message has not reached the server conversation yet.
  if (!conversationId || !messageId || conversationId.startsWith('session:')) return null;
  return { conversationId, messageId };
}

export function seenRowState(request: MessageReadersRequest | null): SeenRowState {
  if (!request || request.status === 'failed') return { kind: 'hidden' };
  if (request.status === 'loading') return { kind: 'loading' };
  const { total, readers } = request.page;
  if (total <= 0) return { kind: 'none' };
  if (total === 1 && readers[0]) return { kind: 'one', reader: readers[0] };
  return { kind: 'several', total, readers: readers.slice(0, SEEN_BY_PREVIEW_LIMIT) };
}

/** Group members other than agents; the server counts the same people. */
export function seenByActiveMemberCount(participants: readonly ConversationParticipant[] | undefined): number {
  return (participants ?? []).filter((participant) => participant.kind === 'human').length;
}

export function seenByPeopleLookup(
  participants: readonly ConversationParticipant[] | undefined,
): (accountId: string) => MessageSeenByPerson {
  const byAccountId = new Map<string, MessageSeenByPerson>();
  for (const participant of participants ?? []) {
    if (participant.kind !== 'human') continue;
    const person = {
      id: participant.id,
      name: participant.name.trim() || participant.publicName?.trim() || 'Someone',
      avatarSeed: participant.avatarKey ?? null,
      profileImageUrl: participant.profileImageUrl ?? null,
    };
    const keys = [
      participant.id.startsWith('human:') ? participant.id.slice('human:'.length) : '',
      participant.humanId,
      participant.sourceIdentityId,
    ];
    for (const key of keys) {
      const accountId = key?.trim();
      if (accountId && !byAccountId.has(accountId)) byAccountId.set(accountId, person);
    }
  }
  return (accountId) => byAccountId.get(accountId)
    ?? { id: `human:${accountId}`, name: 'Someone', avatarSeed: null, profileImageUrl: null };
}

/** Starts one readers request; the returned cancel turns a late answer into a no-op. */
export function requestMessageReaders(
  source: Pick<MessageSeenBySource, 'fetchReaders'>,
  target: MessageSeenByTarget,
  limit: number,
  onSettled: (request: Exclude<MessageReadersRequest, { status: 'loading' }>) => void,
): () => void {
  let active = true;
  source.fetchReaders(target, limit).then(
    (page) => { if (active) onSettled({ status: 'ready', page }); },
    () => { if (active) onSettled({ status: 'failed' }); },
  );
  return () => { active = false; };
}
