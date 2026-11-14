// Group › Add people's "From Grounding" section: people the group's owner or admin shares
// Grounding with who are not contacts yet, and inviting them. It stays small: the sidebar's
// group panel imports it outside the lazy Grounding page.

import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';

export type GroupGroundingPerson = {
  accountId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  /** The room both are still in; null when they share a match or a pairing ("Match"). */
  source: string | null;
  /** A pending invitation to this group exists. */
  invited: boolean;
};

/** The route takes at most this many account ids per request. */
const INVITE_BATCH = 20;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function normalizeGroupGroundingPeople(body: unknown): GroupGroundingPerson[] {
  const rows = body && typeof body === 'object' ? (body as { people?: unknown }).people : null;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((value) => {
    const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const person = row.person && typeof row.person === 'object' ? row.person as Record<string, unknown> : {};
    const accountId = text(person.accountId);
    if (!accountId) return [];
    return [{
      accountId,
      name: text(person.name) ?? 'Someone',
      handle: text(person.handle),
      avatarUrl: text(person.avatarUrl),
      source: text(row.source),
      invited: row.invited === true,
    }];
  });
}

async function bearer(): Promise<Record<string, string>> {
  const session = await loadSession();
  if (!session?.token) throw new Error('Sign in to invite people.');
  return { authorization: `Bearer ${session.token}` };
}

/** People the viewer can invite into the group; throws when the server has no route or refuses. */
export async function listGroupGroundingPeople(groupSpaceId: string): Promise<GroupGroundingPerson[]> {
  const body = await defaultCloudAuthClient().request<unknown>(
    `/v1/cloud/common-ground/group-people?groupSpaceId=${encodeURIComponent(groupSpaceId)}`,
    { method: 'GET', headers: await bearer() },
    'Could not load people from Grounding.',
  );
  return normalizeGroupGroundingPeople(body);
}

type InviteReply = { invited?: unknown[]; added?: unknown[]; skipped?: Array<{ reason?: unknown }> } | null;

/** Invites people into the group; fails only when none of them could be invited. */
export async function inviteGroundingPeople(groupSpaceId: string, accountIds: string[]): Promise<void> {
  const headers = { ...await bearer(), 'content-type': 'application/json' };
  let sent = 0;
  let limited = false;
  for (let start = 0; start < accountIds.length; start += INVITE_BATCH) {
    const reply = await defaultCloudAuthClient().request<InviteReply>(
      '/v1/cloud/common-ground/group-invitations',
      { method: 'POST', headers, body: JSON.stringify({ groupSpaceId, accountIds: accountIds.slice(start, start + INVITE_BATCH) }) },
      'Could not send the invitations.',
    );
    sent += (reply?.invited?.length ?? 0) + (reply?.added?.length ?? 0);
    limited ||= (reply?.skipped ?? []).some((entry) => entry?.reason === 'limit');
  }
  if (sent === 0 && accountIds.length) {
    throw new Error(limited ? 'You have too many pending invitations. Try again later.' : "These people can't be invited.");
  }
}
