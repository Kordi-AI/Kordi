import { cloudConversationKindFromConversationId, cloudPeerAccountIdFromConversationId, cloudSessionIdFromConversationId } from '@/features/collaboration/conversationIds';

const DIRECT_PERSON_SESSION_PREFIX = 'session:direct-person:';

/**
 * The accounts a hosted one-to-one chat names in its own id, lowercased. Ids
 * decide who is in the chat, so a contact who shares a member's name but is
 * not in it is never offered or targeted there.
 */
export function directChatMemberKeys(conversation: { id?: string; canonicalSessionId?: string } | null | undefined) {
  const keys = new Set<string>();
  const id = conversation?.id?.trim() ?? '';
  const person = Boolean(id) && cloudConversationKindFromConversationId(id) === 'person';
  const peer = person ? cloudPeerAccountIdFromConversationId(id) : null;
  if (peer) keys.add(peer.toLowerCase());
  for (const sessionId of [conversation?.canonicalSessionId, id, person ? cloudSessionIdFromConversationId(id) : null]) {
    const value = sessionId?.trim() ?? '';
    if (!value.startsWith(DIRECT_PERSON_SESSION_PREFIX)) continue;
    for (const member of value.slice(DIRECT_PERSON_SESSION_PREFIX.length).split(':')) {
      if (member.trim()) keys.add(member.trim().toLowerCase());
    }
  }
  return keys;
}

/**
 * Whether an owner is a member of a hosted one-to-one chat by id: true or
 * false when the chat's id settles it, null when it does not.
 */
export function directChatHasMember(conversation: { id?: string; canonicalSessionId?: string } | null | undefined, ...ownerKeys: string[]) {
  const members = directChatMemberKeys(conversation);
  const keys = ownerKeys.filter(Boolean);
  if (members.size === 0 || keys.length === 0) return null;
  if (keys.some((key) => members.has(key))) return true;
  // Both members are known only from a direct-person session id.
  return members.size >= 2 ? false : null;
}
