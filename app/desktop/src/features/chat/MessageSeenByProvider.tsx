import { useMemo, type ReactNode } from 'react';

import { fetchMessageReaders } from '@/features/cloud/messageReadersClient';
import type { ConversationParticipant } from '@/kordi-app/types';
import {
  seenByActiveMemberCount,
  seenByPeopleLookup,
  type MessageSeenBySource,
} from './messageSeenBy';
import { MessageSeenByContext } from './messageSeenByContext';

/** Offers the Seen row to message menus of a group transcript. */
export function MessageSeenByProvider({
  isGroup,
  participants,
  fetchReaders = fetchMessageReaders,
  children,
}: {
  isGroup: boolean;
  participants: readonly ConversationParticipant[] | undefined;
  fetchReaders?: MessageSeenBySource['fetchReaders'];
  children: ReactNode;
}) {
  const source = useMemo<MessageSeenBySource | null>(() => (isGroup
    ? {
        activeMemberCount: seenByActiveMemberCount(participants),
        person: seenByPeopleLookup(participants),
        fetchReaders,
      }
    : null), [fetchReaders, isGroup, participants]);
  return <MessageSeenByContext.Provider value={source}>{children}</MessageSeenByContext.Provider>;
}
