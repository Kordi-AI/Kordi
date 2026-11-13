import type { CollaborationMentionCandidate, SharedCloudAgentMentionCandidate } from './mentions';
import { mentionHandleForLabel, normalizeMentionLabel } from './mentionHandles';

export function identitySuffixForCandidate(candidate: Pick<CollaborationMentionCandidate, 'peer' | 'handle'>) {
  const source = candidate.peer.humanId?.trim()
    || candidate.peer.agentId?.trim()
    || candidate.peer.nodeId?.trim()
    || candidate.handle;
  return mentionHandleForLabel(source, 'target').slice(0, 8);
}

export function uniqueHandle(baseHandle: string, suffix: string) {
  const cleanSuffix = mentionHandleForLabel(suffix, 'target');
  const availableBaseLength = Math.max(1, 64 - cleanSuffix.length);
  return `${baseHandle.slice(0, availableBaseLength)}${cleanSuffix}`;
}

/**
 * Agent handles must be unique in a conversation: two people can share a
 * name, and so can their agents. An agent whose handle is already taken (by
 * the viewer's own agent or an agent listed before it) gets a deterministic
 * suffix from its owner's identity, never a silent tie. The suffix stays
 * internal: people see and type `baseHandle`, and a picked mention carries
 * the agent's id.
 */
export function reserveAgentMentionHandles<T extends { handle: string; normalizedHandle: string; targetKind: string; baseHandle?: string }>(
  candidates: readonly T[],
  used: Set<string>,
  ownerKey: (candidate: T) => string,
): T[] {
  return candidates.map((candidate) => {
    if (candidate.targetKind === 'person') return candidate;
    let handle = candidate.handle;
    let normalizedHandle = candidate.normalizedHandle;
    let collisionIndex = 2;
    const suffix = mentionHandleForLabel(ownerKey(candidate), 'agent').slice(0, 8);
    while (used.has(normalizedHandle)) {
      handle = uniqueHandle(candidate.handle, collisionIndex === 2 ? suffix : `${suffix}${collisionIndex}`);
      normalizedHandle = normalizeMentionLabel(handle);
      collisionIndex += 1;
    }
    used.add(normalizedHandle);
    return handle === candidate.handle ? candidate : { ...candidate, handle, normalizedHandle, baseHandle: candidate.baseHandle ?? candidate.handle };
  });
}
/** Collaboration and shared agent candidates with every agent handle unique. */
export function uniqueAgentMentionCandidates(
  collaboration: readonly CollaborationMentionCandidate[],
  shared: readonly SharedCloudAgentMentionCandidate[],
  reservedHandles: readonly string[] = [],
) {
  const used = new Set(reservedHandles.map((handle) => normalizeMentionLabel(mentionHandleForLabel(handle))));
  // A contact's default agent is already listed from the contact; the
  // co-member listing of the same agent is not a second agent.
  const collaborationAgentIds = new Set(collaboration
    .filter((candidate) => candidate.targetKind === 'agent')
    .map((candidate) => candidate.peer.agentId?.trim())
    .filter(Boolean));
  return {
    collaboration: reserveAgentMentionHandles(collaboration, used, (candidate) => identitySuffixForCandidate(candidate)),
    shared: reserveAgentMentionHandles(
      shared.filter((candidate) => !collaborationAgentIds.has(candidate.targetAgentId)),
      used,
      (candidate) => candidate.targetOwnerAccountId,
    ),
  };
}


/** Owner names that two known people share; such a name alone never decides. */
export function ambiguousOwnerNames(candidates: readonly Pick<CollaborationMentionCandidate, 'peer'>[]) {
  const owners = new Map<string, Set<string>>();
  for (const { peer } of candidates) {
    const name = peer.ownerName?.trim().toLowerCase() ?? '';
    if (name) owners.set(name, (owners.get(name) ?? new Set()).add((peer.humanId || peer.nodeId || '').trim().toLowerCase()));
  }
  return new Set([...owners].filter(([, ids]) => ids.size > 1).map(([name]) => name));
}
