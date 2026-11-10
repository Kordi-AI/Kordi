import { defaultCloudAgentId } from '@/features/cloud/cloudAgentIdentity';
import { stripSelfPossessivePrefix } from '@/lib/identityLabels';
import type { SharedCloudAgentSummary } from '@/features/cloud/cloudAgents';
import type { DesktopChatState, DesktopCollaborationState } from '@/kordi-app/types';
import type { ComposerMentionOption } from '@/kordi-app/components';
import type { ResolvedMentionedCollaborationTarget } from './types';
import { buildCollaborationMentionCandidates, conversationHasGroupMentionScope, conversationHasParticipantMentionScope, filterCollaborationMentionCandidatesForConversation, localAgentMentionLabels, resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh, resolveMentionedCollaborationTarget, resolveMentionedLocalAgentTarget, sharedCloudAgentMentionCandidatesForConversation, type MentionScopeConversation } from './mentions';
import { mentionTextStartsWithLabel } from './localAgentMentions';
import { normalizeMentionLabel } from './mentionHandles';

export { cloudGroupSendPlan } from './cloudGroupSendPlan';

export function selectedComposerAgentMentionTarget(
  text: string,
  option: ComposerMentionOption | null,
  collaborationState: DesktopCollaborationState | null,
): ResolvedMentionedCollaborationTarget | null {
  const mentionStart = option?.targetKind === 'agent'
    ? text.toLocaleLowerCase().indexOf(`@${option.value}`.toLocaleLowerCase())
    : -1;
  if (!option || mentionStart < 0) return null;
  const host = collaborationState?.hosts.find(
    (candidate) => candidate.id === option.sourceHostId,
  ) ?? null;
  if (!host) return null;
  const peer = host.visiblePeers.find((candidate) => (
    option.agentId ? candidate.agentId === option.agentId
      : Boolean(option.humanId && candidate.humanId === option.humanId) || candidate.nodeId === option.nodeId
  )) ?? {
    nodeId: option.nodeId,
    displayName: option.label,
    ownerName: option.ownerName ?? host.ownerName,
    runtime: option.runtime,
    humanId: option.humanId ?? host.humanId ?? null,
    agentId: option.agentId ?? null,
    profileImageUrl: option.avatarImageUrl ?? null,
  } as DesktopCollaborationState['hosts'][number]['visiblePeers'][number];
  return {
    host,
    peer,
    label: option.value,
    displayLabel: option.label,
    targetKind: 'agent',
    requestText: text,
    mentionStart,
  };
}

const mentionStartOf = (target: ResolvedMentionedCollaborationTarget | null) => target?.mentionStart ?? Number.POSITIVE_INFINITY;

/**
 * The agent mentioned first leads the request; agents mentioned later are
 * discussion partners it can reach. On a tie the earlier candidate wins.
 */
export function leadingAgentMentionTarget(...candidates: Array<ResolvedMentionedCollaborationTarget | null>) {
  return candidates.reduce<ResolvedMentionedCollaborationTarget | null>((lead, candidate) => (
    candidate && (!lead || mentionStartOf(candidate) < mentionStartOf(lead)) ? candidate : lead
  ), null);
}

/**
 * The composer remembers only the last agent picked. It leads when it is the
 * first mention; otherwise the text decides, so a partner named later never
 * takes over the request.
 */
export async function resolveLeadingAgentMentionTarget(
  text: string,
  selected: ResolvedMentionedCollaborationTarget | null,
  resolve: () => Promise<ResolvedMentionedCollaborationTarget | null>,
) {
  const firstMention = /(^|\s)@/u.exec(text);
  if (selected && firstMention && selected.mentionStart === firstMention.index + firstMention[1].length) return selected;
  return leadingAgentMentionTarget(selected, await resolve());
}

export async function resolvePreferredAgentMentionTarget(
  text: string,
  desktopChatState: DesktopChatState | null,
  collaborationState: DesktopCollaborationState | null,
  conversation: MentionScopeConversation | null | undefined,
  sharedCloudAgents: SharedCloudAgentSummary[],
  refreshSharedCloudAgents: (() => Promise<SharedCloudAgentSummary[]>) | undefined,
  skip: boolean,
  canResolveLocal: boolean,
) {
  if (!skip && conversationHasGroupMentionScope(conversation)
    && /^\s*@(?:kordi|my\s*kordi)(?=$|[\s:;,.!?—-])/iu.test(text)) {
    const alias = /^\s*@(?:kordi|my\s*kordi)(?=$|[\s:;,.!?—-])/iu.exec(text)![0].trim();
    const local = canResolveLocal ? resolveMentionedLocalAgentTarget(
      text.replace(alias, '@Kordi'), desktopChatState, collaborationState,
    ) : null;
    return local ? { ...local, label: alias.slice(1) } : null;
  }
  const activeHost = collaborationState?.hosts.find((host) => host.id === collaborationState.activeHostId)
    ?? collaborationState?.hosts[0]
    ?? null;
  const cachedRemoteTarget = skip ? null : resolveMentionedCollaborationTarget(
    text,
    collaborationState,
    conversation,
    {
      targetKind: 'agent',
      sharedCloudAgents,
      localAccountId: activeHost?.humanId ?? activeHost?.nodeId ?? null,
      // The viewer's own agent keeps its handle; another agent of the same
      // name needs its own, so a typed handle never picks the wrong agent.
      reservedHandles: canResolveLocal
        ? localAgentMentionLabels(desktopChatState, collaborationState).filter((label) => normalizeMentionLabel(label) !== 'kordi')
        : [],
    },
  );
  const localCandidate = !skip && canResolveLocal
    ? resolveMentionedLocalAgentTarget(text, desktopChatState, collaborationState)
    : null;
  const afterAt = text.replace(/^\s*@/, '');
  const localTarget = localCandidate && localAgentMentionLabels(desktopChatState, collaborationState).some((label) => (
    normalizeMentionLabel(label) !== 'kordi' && mentionTextStartsWithLabel(afterAt, label)
  )) ? localCandidate : null;
  return leadingAgentMentionTarget(cachedRemoteTarget, localTarget) ?? (skip ? null : resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh(
    text, collaborationState, conversation, sharedCloudAgents, refreshSharedCloudAgents,
  ));
}

/**
 * Whether a typed (not picked) leading agent handle names more than one agent
 * here, such as two people's agents that share a name. Such a message must
 * not be sent to a guessed agent; the person picks one from the list.
 */
export function typedAgentMentionIsAmbiguous(
  text: string,
  desktopChatState: DesktopChatState | null,
  collaborationState: DesktopCollaborationState | null,
  conversation: MentionScopeConversation | null | undefined,
  sharedCloudAgents: SharedCloudAgentSummary[],
) {
  const first = /(^|\s)@/u.exec(text);
  if (!first || !conversationHasParticipantMentionScope(conversation)) return false;
  const afterAt = text.slice(first.index + first[1].length + 1);
  const named = (handle: string) => normalizeMentionLabel(handle) !== 'kordi' && mentionTextStartsWithLabel(afterAt, handle);
  const activeHost = collaborationState?.hosts.find((host) => host.id === collaborationState.activeHostId) ?? collaborationState?.hosts[0] ?? null;
  const self = activeHost?.humanId?.trim() || activeHost?.nodeId?.trim() || '';
  const agents = new Set<string>();
  if (localAgentMentionLabels(desktopChatState, collaborationState).some(named)) agents.add(`cloud-agent:${self}`);
  for (const candidate of filterCollaborationMentionCandidatesForConversation(buildCollaborationMentionCandidates(collaborationState), conversation)) {
    if (candidate.targetKind !== 'agent' || !named(candidate.baseHandle ?? candidate.handle)) continue;
    const owner = candidate.peer.humanId?.trim() || candidate.peer.nodeId?.trim() || '';
    agents.add(candidate.peer.agentId?.trim() || `cloud-agent:${owner}`);
  }
  for (const candidate of sharedCloudAgentMentionCandidatesForConversation(sharedCloudAgents, conversation, self || null)) {
    if (named(candidate.baseHandle ?? candidate.handle)) agents.add(candidate.targetAgentId);
  }
  return agents.size > 1;
}

export function cloudAgentMentionIdentity(target: ResolvedMentionedCollaborationTarget | null) {
  const ownerAccountId = target?.peer.humanId?.trim() || target?.peer.nodeId?.trim() || '';
  const agentId = target?.peer.agentId?.trim() || '';
  const targetCloudAgentId = target
    ? agentId.startsWith('cloud_agent_') || agentId.startsWith('cloud-agent:')
      ? agentId
      : defaultCloudAgentId(ownerAccountId)
    : null;
  return {
    targetCloudAgentId,
    targetCloudAgentName: targetCloudAgentId
      ? stripSelfPossessivePrefix(target?.displayLabel, target?.peer.ownerName) || 'Kordi'
      : null,
    ownerAccountId: targetCloudAgentId ? ownerAccountId : null,
  };
}

export function resolveCloudAgentMentionTargetIds(
  isGroup: boolean,
  groupTargetIds: string[],
  mentionedOwnerAccountId: string | null,
) {
  return isGroup
    ? [...new Set([...groupTargetIds, ...(mentionedOwnerAccountId ? [mentionedOwnerAccountId] : [])])]
    : mentionedOwnerAccountId ? [mentionedOwnerAccountId] : [];
}
