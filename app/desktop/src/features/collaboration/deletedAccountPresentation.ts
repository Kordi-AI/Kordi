import { metadataWithDeletedPeerAccount } from '@/features/chat/closedGroup';
import { KORDI_DELETED_ACCOUNT_ID } from '@/features/systemAgent/systemAgentIdentity';
import type { Conversation, DesktopCollaborationConversation } from '@/kordi-app/types';

/** A hosted person chat kept after the other person's account was deleted. */
export type DeletedPeerAccountMark = {
  /** When the server closed the chat because the other account was deleted. */
  peerAccountDeletedAt?: string | null;
};

export function deletedPeerAccountClosedAt(conversation: DesktopCollaborationConversation): string | null {
  return (conversation as DesktopCollaborationConversation & DeletedPeerAccountMark).peerAccountDeletedAt?.trim() || null;
}

/**
 * Presents a kept chat with a deleted account: closed and read-only through the
 * closed-chat metadata, with the stand-in's neutral avatar instead of one drawn
 * from the deleted account. Any other chat is returned as it is.
 */
export function withDeletedAccountPresentation<T extends Conversation>(
  viewModel: T,
  conversation: DesktopCollaborationConversation,
): T {
  const closedAt = deletedPeerAccountClosedAt(conversation);
  if (!closedAt) return viewModel;
  const peerSeeds = new Map([
    [conversation.identity?.remoteHumanId?.trim(), KORDI_DELETED_ACCOUNT_ID],
    [conversation.identity?.remoteAgentId?.trim(), `cloud-agent:${KORDI_DELETED_ACCOUNT_ID}`],
  ].filter((entry): entry is [string, string] => Boolean(entry[0])));
  const neutral = (seed: string | null | undefined) => (seed && peerSeeds.get(seed)) ?? seed;
  // The stand-in has no agent. A chat list row draws a person from their agent id first, so
  // with none it draws the stand-in's own avatar seed. The account id stays: it keys the chat.
  const identity = viewModel.identity && { ...viewModel.identity, remoteAgentId: null };
  const collaborationTarget = viewModel.collaborationTarget
    && { ...viewModel.collaborationTarget, agentId: neutral(viewModel.collaborationTarget.agentId) };
  return {
    ...viewModel,
    identity,
    collaborationTarget,
    metadata: metadataWithDeletedPeerAccount(viewModel.metadata, closedAt),
    avatarSeed: neutral(viewModel.avatarSeed),
    profileImageUrl: null,
    participantAvatarSeeds: viewModel.participantAvatarSeeds && Object.fromEntries(
      Object.entries(viewModel.participantAvatarSeeds).map(([name, seed]) => [name, neutral(seed) ?? seed]),
    ),
    messages: viewModel.messages.map((message) => {
      const seed = neutral(message.senderAvatarSeed);
      return seed === message.senderAvatarSeed ? message : { ...message, senderAvatarSeed: seed };
    }),
  };
}
