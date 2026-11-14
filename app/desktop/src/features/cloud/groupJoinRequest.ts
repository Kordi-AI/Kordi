import { defaultCloudAuthClient } from './authClient';

/** A room member's request to join a group started from that room, as a card in the group. */
export type GroupJoinRequestCard = {
  requestId: string;
  groupSpaceId: string;
  conversationId: string | null;
  groupName: string;
  roomName: string;
  requester: { accountId: string; name: string; avatarUrl: string | null };
  status: 'pending' | 'approved' | 'declined' | 'cancelled';
  approverIds: string[];
  decidedByName: string | null;
  revision: number;
};

const STATUSES = new Set(['pending', 'approved', 'declined', 'cancelled']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function person(value: unknown): { accountId: string; name: string; avatarUrl: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const accountId = text(row.accountId);
  if (!accountId) return null;
  return { accountId, name: text(row.name) ?? 'Someone', avatarUrl: text(row.avatarUrl) };
}

export function normalizeGroupJoinRequestCard(value: unknown): GroupJoinRequestCard | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const requestId = text(row.requestId);
  const requester = person(row.requester);
  const status = typeof row.status === 'string' && STATUSES.has(row.status) ? row.status as GroupJoinRequestCard['status'] : null;
  if (!requestId || !requester || !status || typeof row.revision !== 'number') return null;
  return {
    requestId, requester, status, revision: row.revision,
    groupSpaceId: text(row.groupSpaceId) ?? '',
    conversationId: text(row.conversationId),
    groupName: text(row.groupName) ?? '',
    roomName: text(row.roomName) ?? '',
    approverIds: Array.isArray(row.approverIds) ? row.approverIds.filter((id): id is string => typeof id === 'string') : [],
    decidedByName: person(row.decidedBy)?.name ?? text(row.decidedByName),
  };
}

/** The card block in a chat message's content, if any. */
export function groupJoinRequestFromChatContent(content: unknown): GroupJoinRequestCard | null {
  const blocks = (content as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(blocks)) return null;
  for (const value of blocks) {
    if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'group_join_request') continue;
    const card = normalizeGroupJoinRequestCard(value);
    if (card) return card;
  }
  return null;
}

/** Reads the request, or approves or declines it. */
export async function groupJoinRequestRequest(token: string, id: string, action?: 'approve' | 'decline') {
  const value = await defaultCloudAuthClient().request<unknown>(
    `/v1/cloud/common-ground/join-requests/${encodeURIComponent(id)}`,
    {
      method: action ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(action ? { body: JSON.stringify({ action }) } : {}),
    },
    'Could not update the request.',
  );
  const wrapped = value && typeof value === 'object' && 'request' in value ? value.request : value;
  const card = normalizeGroupJoinRequestCard(wrapped);
  if (!card) throw new Error('The request is unavailable.');
  return card;
}
