import { defaultCloudAuthClient } from './authClient';

export type FacilitatorCard = {
  cardId: string;
  kind: 'decision' | 'memory' | 'task';
  title: string;
  detail: string | null;
  options: string[];
  counts: number[];
  myVote: number | null;
  assigneeId: string | null;
  assigneeName: string | null;
  managerIds: string[];
  revision: number;
  result: string | null;
};

export function normalizeFacilitatorCard(value: unknown): FacilitatorCard | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<FacilitatorCard>;
  if (typeof row.cardId !== 'string' || typeof row.title !== 'string' || typeof row.revision !== 'number') return null;
  if (row.kind !== 'decision' && row.kind !== 'memory' && row.kind !== 'task') return null;
  return {
    cardId: row.cardId, title: row.title, kind: row.kind, revision: row.revision,
    detail: typeof row.detail === 'string' ? row.detail : null,
    options: Array.isArray(row.options) ? row.options.filter(option => typeof option === 'string') : [],
    counts: Array.isArray(row.counts) ? row.counts : [],
    myVote: typeof row.myVote === 'number' && Number.isInteger(row.myVote) && row.myVote >= 0 ? row.myVote : null,
    assigneeId: typeof row.assigneeId === 'string' ? row.assigneeId : null,
    assigneeName: typeof row.assigneeName === 'string' ? row.assigneeName : null,
    managerIds: Array.isArray(row.managerIds) ? row.managerIds : [],
    result: typeof row.result === 'string' ? row.result : null,
  };
}

export type FacilitatorAction =
  | { action: 'vote' | 'confirm'; revision: number; option: number }
  | { action: 'save_memory'; revision: number }
  | { action: 'approve' | 'decline' };

export async function facilitatorCardRequest(token: string, id: string, action?: FacilitatorAction) {
  const value = await defaultCloudAuthClient().request<unknown>(
    `/v1/cloud/facilitator/cards/${encodeURIComponent(id)}`,
    {
      method: action ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(action ? { body: JSON.stringify(action) } : {}),
    },
    'Could not load or update the Facilitator card.',
  );
  const card = normalizeFacilitatorCard(value);
  if (!card) throw new Error('The Facilitator card is unavailable.');
  return card;
}
