import {
  decodeMessageReadersPage,
  SEEN_BY_LIST_LIMIT,
  type MessageReadersPage,
  type MessageSeenByTarget,
} from '@/features/chat/messageSeenBy';
import { defaultCloudAuthClient, type CloudAuthClient } from './authClient';
import { loadSession } from './session';

type MessageReadersDeps = {
  client?: Pick<CloudAuthClient, 'request'>;
  loadSession?: () => Promise<{ token?: string | null } | null>;
};

/** `GET /v2/chat/conversations/:id/messages/:message_id/readers?limit=N`. */
export async function fetchMessageReaders(
  target: MessageSeenByTarget,
  limit: number,
  deps: MessageReadersDeps = {},
): Promise<MessageReadersPage> {
  const session = await (deps.loadSession ?? loadSession)();
  if (!session?.token) throw new Error('Sign in to Kordi first.');
  const boundedLimit = Math.min(Math.max(Math.floor(limit) || 1, 1), SEEN_BY_LIST_LIMIT);
  const client = deps.client ?? defaultCloudAuthClient();
  const body = await client.request<unknown>(
    `/v2/chat/conversations/${encodeURIComponent(target.conversationId)}/messages/${encodeURIComponent(target.messageId)}/readers?limit=${boundedLimit}`,
    { method: 'GET', headers: { authorization: `Bearer ${session.token}` } },
    'Could not load who has seen this message.',
  );
  return decodeMessageReadersPage(body);
}
