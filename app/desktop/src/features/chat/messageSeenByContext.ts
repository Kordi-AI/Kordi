import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  requestMessageReaders,
  type MessageReadersRequest,
  type MessageSeenBySource,
  type MessageSeenByTarget,
} from './messageSeenBy';

/** Present only around a group transcript; absent means no Seen row. */
export const MessageSeenByContext = createContext<MessageSeenBySource | null>(null);

export function useMessageSeenBySource(): MessageSeenBySource | null {
  return useContext(MessageSeenByContext);
}

/**
 * Loads readers once per mount and target. A response that arrives after the
 * menu closed or moved to another message is ignored.
 */
export function useMessageReaders(
  source: MessageSeenBySource | null,
  target: MessageSeenByTarget | null,
  limit: number,
): MessageReadersRequest | null {
  const conversationId = target?.conversationId ?? null;
  const messageId = target?.messageId ?? null;
  const key = conversationId && messageId ? `${conversationId}\u0000${messageId}\u0000${limit}` : null;
  const [settled, setSettled] = useState<{ key: string; request: MessageReadersRequest } | null>(null);
  // The source is rebuilt with the transcript; only the target decides when to load.
  const sourceRef = useRef(source);
  useLayoutEffect(() => { sourceRef.current = source; });
  useEffect(() => {
    const current = sourceRef.current;
    if (!current || !conversationId || !messageId) return;
    const requestKey = `${conversationId}\u0000${messageId}\u0000${limit}`;
    return requestMessageReaders(current, { conversationId, messageId }, limit, (request) => {
      setSettled({ key: requestKey, request });
    });
  }, [conversationId, messageId, limit]);
  if (!key || !source) return null;
  return settled?.key === key ? settled.request : { status: 'loading' };
}
