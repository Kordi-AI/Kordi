import { isSystemAgentIdentity, KORDI_FACILITATOR_NAME, KORDI_SYSTEM_AVATAR_URL, KORDI_SYSTEM_NAME, KORDI_SYSTEM_NOTICE_KIND } from '@/features/systemAgent/systemAgentIdentity';
import { defaultCloudAgentId } from '@/features/cloud/cloudAgentIdentity';
import type { CanonicalIdentity, CanonicalSessionMessage, Message } from '@/kordi-app/types';
import type { MessagePlanCard } from '@/kordi-app/types/message';
import { defaultAgentDisplayName } from '@/lib/identityLabels';
import { canonicalIdentityAvatarSeed } from '@/features/canonical/avatarIdentity';

// Takes the kind itself: the read model counts property reads per row.
export function isSystemNoticeKind(messageKind: CanonicalSessionMessage['messageKind'] | null | undefined): boolean {
  return messageKind?.trim() === KORDI_SYSTEM_NOTICE_KIND;
}

/** A server group event, such as "Ava created the group": a notice that names its `group_event`.
 * It reads as a small centered line, not a bubble. */
export function isGroupEventNotice(messageKind: CanonicalSessionMessage['messageKind'] | null | undefined, content: unknown): boolean {
  if (!isSystemNoticeKind(messageKind) || !content || typeof content !== 'object' || Array.isArray(content)) return false;
  const event = (content as { group_event?: unknown }).group_event;
  return Boolean(event) && typeof event === 'object' && !Array.isArray(event);
}

/** Sender identity for a server notice or the plan agent; null keeps the poster's own identity.
 * The seed keeps notices from grouping with the posting account's own messages. A notice is
 * never an own bubble, even when the viewer's account posted it (an organizer's plan card). */
export function systemNoticeSender(messageKind: CanonicalSessionMessage['messageKind'] | null | undefined, sender?: Parameters<typeof isSystemAgentIdentity>[0],
  planCard?: MessagePlanCard | null, viewerIsOwner = false, identityById?: Map<string, CanonicalIdentity>, facilitatorCard = false) {
  const agent = isSystemNoticeKind(messageKind) ? planCardAgentSender(planCard, viewerIsOwner, identityById) : null;
  if (agent) return agent;
  const fromFacilitator = isSystemAgentIdentity(sender) && (!isSystemNoticeKind(messageKind) || Boolean(planCard) || facilitatorCard);
  if (!fromFacilitator && !isSystemNoticeKind(messageKind)) return null;
  const name = fromFacilitator ? KORDI_FACILITATOR_NAME : KORDI_SYSTEM_NAME;
  return {
    sender: name,
    sourceSenderLabel: name,
    senderProfileImageUrl: KORDI_SYSTEM_AVATAR_URL,
    showSenderMeta: true,
    senderAvatarSeed: fromFacilitator ? 'kordi-facilitator' : 'kordi-system',
    senderOwnerName: undefined,
    isOwnMessage: false,
  };
}

/** Direct-chat rows: re-dresses a mapped message as a System notice, dropping the poster's
 * outbound role, status chips and read receipts. Other kinds pass through unchanged. */
export function withSystemNoticeIdentity(message: Message): Message {
  // The viewer posted an agent card's notice only as that agent's owner.
  const agent = isSystemNoticeKind(message.messageKind) ? planCardAgentSender(message.planCard, Boolean(message.isOwnMessage)) : null;
  if (agent) return { ...message, ...agent, statusChips: [], readReceiptSummary: null };
  const notice = systemNoticeSender(message.messageKind);
  return notice
    ? { ...message, ...notice, role: 'person', senderType: 'human', sourceSenderLabel: KORDI_SYSTEM_NAME, statusChips: [], readReceiptSummary: null }
    : message;
}

/** A card a person's agent opened travels in its owner's notice, but it is that agent's message:
 * the agent's name and picture with its owner line, never System. Null for System agent cards. */
export function planCardAgentSender(card: MessagePlanCard | null | undefined, viewerIsOwner: boolean, identityById?: Map<string, CanonicalIdentity>) {
  const planner = card?.plannedBy;
  if (!planner) return null;
  const identity = identityById
    ? [...identityById.values()].find((candidate) => candidate.kind === 'agent' && candidate.agentId?.trim() === planner.agentId)
    : undefined;
  const sender = planner.agentId === defaultCloudAgentId(planner.ownerAccountId)
    ? defaultAgentDisplayName(viewerIsOwner ? null : planner.ownerName, planner.agentName)
    : planner.agentName;
  return {
    role: viewerIsOwner ? 'owned-agent' as const : 'external-agent' as const,
    sender,
    sourceSenderLabel: sender,
    senderOwnerName: viewerIsOwner ? 'You' : planner.ownerName || undefined,
    senderType: 'agent' as const,
    senderProfileImageUrl: identity?.profileImageUrl ?? planner.avatarUrl ?? null,
    senderAvatarSeed: (identity ? canonicalIdentityAvatarSeed(identity) : undefined) ?? (viewerIsOwner ? undefined : planner.agentId),
    showSenderMeta: true,
    isOwnMessage: false,
  };
}
