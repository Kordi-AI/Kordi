import { useCallback, useEffect, useMemo } from 'react';
import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';

import {
  buildCollaborationMentionTargetsByScope,
  mentionableCloudAgentSummaries,
  sharedCloudAgentOwnerIdsForMentionScope,
} from '@/app/useKordiAppModelCollaborationMentions';
import {
  currentMentionQuery,
  filterMentionTargets,
} from '@/app/useKordiAppModelHelpers';
import type { CloudAccount } from '@/features/cloud/authClient';
import type {
  CloudAgentDefinition,
  SharedCloudAgentSummary,
} from '@/features/cloud/cloudAgents';
import type { UseCloudCollaborationStateResult } from '@/features/cloud/useCloudCollaborationState';
import { mentionAgentRefreshGate } from '@/features/chat/messageActions/mentionAgentRefresh';
import { mentionScopeConversationForActiveConversation } from '@/features/chat/messageActions/mentions';
import type {
  Conversation,
  DesktopCollaborationState,
  DesktopChatState,
} from '@/kordi-app/types';

type UseKordiCollaborationMentionsArgs = {
  account: CloudAccount | null;
  activeConversation: Conversation;
  cloudAgentDefinitionsById: Record<string, CloudAgentDefinition>;
  collaborationState: DesktopCollaborationState | null;
  conversations: Conversation[];
  desktopChatState: DesktopChatState | null;
  isNativeShell: boolean;
  refreshSharedCloudAgents:
    UseCloudCollaborationStateResult['refreshSharedCloudAgents'];
  sharedCloudAgents: SharedCloudAgentSummary[];
};

export function useKordiCollaborationMentions({
  account,
  activeConversation,
  cloudAgentDefinitionsById,
  collaborationState,
  conversations,
  desktopChatState,
  isNativeShell,
  refreshSharedCloudAgents,
  sharedCloudAgents,
}: UseKordiCollaborationMentionsArgs) {
  const activeConversationScope = useMemo(
    () => mentionScopeConversationForActiveConversation(
      activeConversation,
      conversations,
    ),
    [activeConversation, conversations],
  );

  const sharedAgentOwnerIds = useMemo(
    () => sharedCloudAgentOwnerIdsForMentionScope(
      activeConversationScope,
      account?.accountId,
    ),
    [account?.accountId, activeConversationScope],
  );

  useEffect(() => {
    void refreshSharedCloudAgents(sharedAgentOwnerIds).catch(() => undefined);
  }, [refreshSharedCloudAgents, sharedAgentOwnerIds]);

  // Refetch when the `@` menu opens or the window regains focus, so an
  // agent its owner just closed stops being offered.
  const refreshGate = useMemo(() => mentionAgentRefreshGate(), []);
  const refreshMentionAgentsSoon = useCallback(() => {
    if (sharedAgentOwnerIds.length === 0 || !refreshGate()) return;
    setTimeout(() => {
      void refreshSharedCloudAgents(sharedAgentOwnerIds).catch(() => undefined);
    }, 0);
  }, [refreshGate, refreshSharedCloudAgents, sharedAgentOwnerIds]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('focus', refreshMentionAgentsSoon);
    return () => window.removeEventListener('focus', refreshMentionAgentsSoon);
  }, [refreshMentionAgentsSoon]);

  const mentionableCloudAgents = useMemo(
    () => mentionableCloudAgentSummaries({
      sharedCloudAgents,
      ownedCloudAgentsById: cloudAgentDefinitionsById,
      ownerDisplayName:
        account?.displayName?.trim()
        || account?.primaryEmail?.trim()
        || null,
    }),
    [
      account?.displayName,
      account?.primaryEmail,
      cloudAgentDefinitionsById,
      sharedCloudAgents,
    ],
  );

  const resolveSharedCloudAgentsForMention = useCallback(async () => {
    const refreshed = await refreshSharedCloudAgents(
      sharedAgentOwnerIds,
    ).catch(() => []);
    return mentionableCloudAgentSummaries({
      sharedCloudAgents: [...sharedCloudAgents, ...refreshed],
      ownedCloudAgentsById: cloudAgentDefinitionsById,
      ownerDisplayName:
        account?.displayName?.trim()
        || account?.primaryEmail?.trim()
        || null,
    });
  }, [
    account?.displayName,
    account?.primaryEmail,
    cloudAgentDefinitionsById,
    refreshSharedCloudAgents,
    sharedAgentOwnerIds,
    sharedCloudAgents,
  ]);

  const targetsByScope = useMemo(
    () => buildCollaborationMentionTargetsByScope({
      // The browser app has the same Cloud people and agents; only local files stay desktop-only.
      isNativeShell: isNativeShell || isBrowserAppRuntime(),
      desktopCollaborationState: collaborationState,
      desktopChatState,
      activeConvMentionScope: activeConversationScope,
      conversations,
      sharedCloudAgents: mentionableCloudAgents,
    }),
    [
      activeConversationScope,
      collaborationState,
      conversations,
      desktopChatState,
      isNativeShell,
      mentionableCloudAgents,
    ],
  );

  const chatMentionTargetsForText = useCallback(
    (text: string, cursor = text.length) => {
      const query = currentMentionQuery(text, cursor);
      if (query) refreshMentionAgentsSoon();
      return filterMentionTargets(targetsByScope.chat, query, { allowLocalFiles: isNativeShell });
    },
    [isNativeShell, refreshMentionAgentsSoon, targetsByScope.chat],
  );
  const projectMentionTargetsForText = useCallback(
    (text: string, cursor = text.length) => filterMentionTargets(
      targetsByScope.project,
      currentMentionQuery(text, cursor),
      { allowLocalFiles: isNativeShell },
    ),
    [isNativeShell, targetsByScope.project],
  );
  return {
    activeConversationScope,
    chatMentionTargetsForText,
    projectMentionTargetsForText,
    mentionableCloudAgents,
    resolveSharedCloudAgentsForMention,
  };
}
