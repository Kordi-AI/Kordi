/** Facilitator is the built-in group agent. Its account is managed on the server. */
// The stored ids keep the agent's old name.
export const KORDI_SYSTEM_AGENT_ACCOUNT_ID = 'acct_kordi_pip';
export const KORDI_SYSTEM_AGENT_CLOUD_AGENT_ID = 'cloud_agent_kordi_pip';

/** The System agent's canonical identity, by the Cloud account or agent id it was created from. */
export function isSystemAgentIdentity(identity: { humanId?: string | null; agentId?: string | null; sourceIdentityId?: string | null } | null | undefined): boolean {
  if (!identity) return false;
  return identity.humanId === KORDI_SYSTEM_AGENT_ACCOUNT_ID
    || identity.agentId === KORDI_SYSTEM_AGENT_CLOUD_AGENT_ID
    || identity.sourceIdentityId === KORDI_SYSTEM_AGENT_ACCOUNT_ID;
}

/** The System agent posts in group chats but is not a member for counts, titles, or read receipts. */
export function isSystemAgentAccountId(accountId: string | null | undefined): boolean {
  return accountId?.trim() === KORDI_SYSTEM_AGENT_ACCOUNT_ID;
}

export const KORDI_FACILITATOR_NAME = 'Facilitator';

/** The @ menu row and mention for the Facilitator. The server answers a mention whose target
 * names its account, so the mention never routes to a cloud agent's owner. */
export const KORDI_FACILITATOR_MENTION_HOST_ID = 'facilitator';
export const KORDI_FACILITATOR_MENTION_TARGET_ID = `agent:cloud-agent:${KORDI_SYSTEM_AGENT_ACCOUNT_ID}`;

export function isFacilitatorMentionOption(option: { sourceHostId?: string | null } | null | undefined): boolean {
  return option?.sourceHostId === KORDI_FACILITATOR_MENTION_HOST_ID;
}

export function isFacilitatorHandoffRequestId(id: string | null | undefined): boolean {
  return id?.startsWith('facilitator-handoff:') ?? false;
}

/** Server notices such as introductions and joins show as the Facilitator, with the
 * front-facing Kordi bird, so they read as the same Facilitator as the agent. */
export const KORDI_SYSTEM_NOTICE_KIND = 'system-notice';
export const KORDI_SYSTEM_NAME = KORDI_FACILITATOR_NAME;
export const KORDI_SYSTEM_AVATAR_URL = publicAssetPath('kordi-system-avatar.jpg');

export function isSystemAvatarUrl(url: string | null | undefined): boolean {
  return url?.trim() === KORDI_SYSTEM_AVATAR_URL;
}

/** The hidden service account that posts Grounding notices. Like the System agent, it is
 * server-managed: never a counted member, participant, peer, or contact. */
export const KORDI_SYSTEM_ACCOUNT_ID = 'acct_kordi_system';

export function isSystemAccountId(accountId: string | null | undefined): boolean {
  return accountId?.trim() === KORDI_SYSTEM_ACCOUNT_ID;
}

/** The server-managed stand-in for every deleted person (docs/development/account-deletion.md). Kept
 * messages of a deleted person come from it; it is only ever a member who left, never a contact. */
export const KORDI_DELETED_ACCOUNT_ID = 'acct_kordi_deleted';
export const KORDI_DELETED_ACCOUNT_NAME = 'Deleted account';

/** An avatar seed that draws the stand-in, or the agent it does not have: no person's face. */
export function isDeletedAccountAvatarSeed(seed: string | null | undefined): boolean {
  const value = seed?.trim() ?? '';
  return value === KORDI_DELETED_ACCOUNT_ID || value === `human:${KORDI_DELETED_ACCOUNT_ID}`
    || value === `cloud-agent:${KORDI_DELETED_ACCOUNT_ID}` || value === `default-agent-${KORDI_DELETED_ACCOUNT_ID}`;
}

/** A message from the stand-in, by its sender identity or avatar seed: it has no profile to open. */
export function isDeletedAccountSender(message: { senderIdentityId?: string | null; senderAvatarSeed?: string | null }): boolean {
  const identityId = message.senderIdentityId?.trim() ?? '';
  return identityId === KORDI_DELETED_ACCOUNT_ID || identityId === `human:${KORDI_DELETED_ACCOUNT_ID}`
    || message.senderAvatarSeed?.trim() === KORDI_DELETED_ACCOUNT_ID;
}

/** The System agent or the system account: server-managed members a client never lists or removes. */
export function isBuiltInAccountId(accountId: string | null | undefined): boolean {
  return isSystemAgentAccountId(accountId) || isSystemAccountId(accountId);
}

/** A canonical identity created from the System agent or the system account. */
export function isBuiltInIdentity(identity: { humanId?: string | null; agentId?: string | null; sourceIdentityId?: string | null } | null | undefined): boolean {
  return isSystemAgentIdentity(identity) || isSystemAccountId(identity?.humanId) || isSystemAccountId(identity?.sourceIdentityId);
}
import { publicAssetPath } from '@/lib/publicAsset';
