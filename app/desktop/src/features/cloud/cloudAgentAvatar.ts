import { canonicalIdentityAvatarSeed } from '@/features/canonical/avatarIdentity';
import type { CanonicalIdentity } from '@/kordi-app/types';

import { cloudAvatarImageUrl } from './avatar';
import { cloudAgentAvatarSeed, cloudAgentId } from './cloudAgentIdentity';

export { cloudAgentAvatarSeed } from './cloudAgentIdentity';

const CLOUD_AGENT_IDENTITY_PREFIX = 'agent:cloud-agent:';
const LEGACY_CLOUD_AGENT_IDENTITY_PREFIX = 'agent:cloud:';
const CLOUD_AGENT_ID_OWNER_PATTERN = /^cloud-(?:agent|self):([A-Za-z0-9_-]+)$/;

function metadataText(identity: CanonicalIdentity | undefined, key: string) {
  const metadata = identity?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The agent id a sender identity id names; `agent:cloud:<account>` is that account's default agent. */
function senderAgentId(senderIdentityId: string | null | undefined) {
  const id = senderIdentityId?.trim() ?? '';
  if (id.startsWith(CLOUD_AGENT_IDENTITY_PREFIX)) return id.slice(CLOUD_AGENT_IDENTITY_PREFIX.length).trim() || null;
  if (!id.startsWith(LEGACY_CLOUD_AGENT_IDENTITY_PREFIX)) return null;
  const accountId = id.slice(LEGACY_CLOUD_AGENT_IDENTITY_PREFIX.length).trim();
  return accountId ? `cloud-agent:${accountId}` : null;
}

/**
 * A transcript row's agent avatar: the agent's picture, then its owner's default-agent
 * profile, then `cloudAgentAvatarSeed`. A row whose agent identity is not stored yet
 * resolves from the sender identity id and the owner's stored identity.
 */
export function canonicalAgentSenderAvatar(input: {
  identity?: CanonicalIdentity;
  senderIdentityId?: string | null;
  ownerAccountId?: string | null;
  identityById: Map<string, CanonicalIdentity>;
}): { seed: string | null; imageUrl: string | null } {
  const { identity, identityById } = input;
  if (identity && (identity.kind !== 'agent' || identity.source === 'local')) {
    return { seed: canonicalIdentityAvatarSeed(identity), imageUrl: identity.profileImageUrl ?? null };
  }
  const agentId = identity?.agentId?.trim() || senderAgentId(input.senderIdentityId);
  const owner = identity?.humanId?.trim()
    || input.ownerAccountId?.trim()
    || agentId?.match(CLOUD_AGENT_ID_OWNER_PATTERN)?.[1]
    || '';
  const ownerIdentity = owner ? identityById.get(`human:${owner}`) : undefined;
  const ownerDefaultAgentId = metadataText(ownerIdentity, 'defaultAgentId');
  const isOwnerDefaultAgent = Boolean(agentId && ownerDefaultAgentId)
    && cloudAgentId(ownerDefaultAgentId, owner) === cloudAgentId(agentId, owner);
  const profileSeed = isOwnerDefaultAgent ? metadataText(ownerIdentity, 'defaultAgentAvatarSeed') : null;
  const profileImageUrl = isOwnerDefaultAgent ? metadataText(ownerIdentity, 'defaultAgentAvatarUrl') : null;
  const imageUrl = identity?.profileImageUrl || cloudAvatarImageUrl(profileImageUrl) || null;
  if (!agentId) return { seed: canonicalIdentityAvatarSeed(identity), imageUrl };
  return { seed: cloudAgentAvatarSeed({ agentId, ownerAccountId: owner, profileSeed }), imageUrl };
}
