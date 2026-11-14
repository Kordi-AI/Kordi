// Room group invitations outside the Grounding page: "Alex invited you to Infrastructure and CI"
// in Contacts › Requests and in the Contacts badge. The list refreshes on Grounding room hints
// (a new invitation, a join or a decline on another device), when the window regains focus,
// and when the account changes. It stays small: the sidebar imports it outside the lazy page.

import { useEffect, useSyncExternalStore } from 'react';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { CloudAuthError } from '@/features/cloud/cloudAuthError';
import { cachedSessionSnapshot, CLOUD_SESSION_CHANGED_EVENT, loadSession } from '@/features/cloud/session';
import { subscribeRoomHints } from './roomHints';

export type RoomGroupInvitation = {
  invitationRef: string;
  code: string;
  roomName: string;
  groupSpaceId: string;
  conversationId: string | null;
  name: string;
  from: { accountId: string; name: string; avatarUrl: string | null };
  createdAt: string;
};

export type RoomInvitationsState = {
  invitations: RoomGroupInvitation[];
  /** The invitation an answer is being sent for. */
  busyRef: string | null;
  error: string | null;
};

type Transport = {
  token: () => Promise<{ token: string; accountId: string } | null>;
  request: <T>(path: string, init: RequestInit, fallback: string) => Promise<T>;
};

const defaultTransport: Transport = {
  token: async () => {
    const session = await loadSession();
    return session?.token ? { token: session.token, accountId: session.accountId } : null;
  },
  request: (path, init, fallback) => defaultCloudAuthClient().request(path, init, fallback),
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function normalizeRoomInvitation(value: unknown): RoomGroupInvitation | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const from = row.from && typeof row.from === 'object' ? row.from as Record<string, unknown> : null;
  const invitationRef = text(row.invitationRef);
  const code = text(row.code);
  const groupSpaceId = text(row.groupSpaceId);
  const fromId = text(from?.accountId);
  if (!invitationRef || !code || !groupSpaceId || !fromId) return null;
  return {
    invitationRef, code, groupSpaceId,
    roomName: text(row.roomName) ?? '',
    conversationId: text(row.conversationId),
    name: text(row.name) ?? 'a group',
    from: { accountId: fromId, name: text(from?.name) ?? 'Someone', avatarUrl: text(from?.avatarUrl) },
    createdAt: text(row.createdAt) ?? '',
  };
}

const EMPTY: RoomInvitationsState = { invitations: [], busyRef: null, error: null };

export function createRoomInvitationsStore(transport: Transport = defaultTransport) {
  let state = EMPTY;
  let account: string | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<RoomInvitationsState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  async function refresh() {
    const ticket = ++generation;
    const session = await transport.token().catch(() => null);
    if (ticket !== generation) return;
    if (!session) {
      account = null;
      if (state !== EMPTY) { state = EMPTY; for (const listener of [...listeners]) listener(); }
      return;
    }
    if (session.accountId !== account) {
      account = session.accountId;
      set({ invitations: [], error: null });
    }
    try {
      const body = await transport.request<{ invitations?: unknown }>(
        '/v1/cloud/common-ground/invitations',
        { method: 'GET', headers: { authorization: `Bearer ${session.token}` } },
        'Could not load invitations.',
      );
      if (ticket !== generation) return;
      const rows = Array.isArray(body?.invitations) ? body.invitations : [];
      set({ invitations: rows.map(normalizeRoomInvitation).filter((row): row is RoomGroupInvitation => row !== null) });
    } catch (error) {
      // Servers without the route list nothing; other failures keep the last list.
      if (ticket === generation && error instanceof CloudAuthError && error.status === 404) set({ invitations: [] });
    }
  }

  /** Joins or declines; true when the answer was accepted. Joining returns the group's ids. */
  async function answer(invitation: RoomGroupInvitation, action: 'join' | 'decline') {
    set({ busyRef: invitation.invitationRef, error: null });
    try {
      const session = await transport.token();
      if (!session) throw new Error('Sign in to answer the invitation.');
      const path = `/v1/cloud/common-ground/rooms/${encodeURIComponent(invitation.code)}/invitations/${encodeURIComponent(invitation.invitationRef)}/${action}`;
      const joined = await transport.request<{ groupSpaceId?: string; conversationId?: string } | null>(
        path,
        { method: 'POST', headers: { authorization: `Bearer ${session.token}` } },
        action === 'join' ? 'Could not join the group.' : 'Could not decline the invitation.',
      );
      set({ invitations: state.invitations.filter((row) => row.invitationRef !== invitation.invitationRef) });
      return { ok: true as const, groupSpaceId: joined?.groupSpaceId ?? invitation.groupSpaceId };
    } catch (error) {
      // A gone invitation (404) is already answered; drop it.
      if (error instanceof CloudAuthError && error.status === 404) {
        set({ invitations: state.invitations.filter((row) => row.invitationRef !== invitation.invitationRef) });
      } else {
        set({ error: error instanceof Error ? error.message : 'Could not answer the invitation.' });
      }
      return { ok: false as const };
    } finally {
      set({ busyRef: null });
      void refresh();
    }
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    join: (invitation: RoomGroupInvitation) => answer(invitation, 'join'),
    decline: (invitation: RoomGroupInvitation) => answer(invitation, 'decline'),
  };
}

export type RoomInvitationsStore = ReturnType<typeof createRoomInvitationsStore>;

let shared: RoomInvitationsStore | null = null;
let wired = false;

export function roomInvitationsStore(): RoomInvitationsStore {
  shared ??= createRoomInvitationsStore();
  if (!wired && typeof window !== 'undefined') {
    wired = true;
    const store = shared;
    subscribeRoomHints(() => { void store.refresh(); });
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, () => { void store.refresh(); });
    window.addEventListener('focus', () => { void store.refresh(); });
  }
  return shared;
}

/** The signed-in account's pending room group invitations; loads them on first use. */
export function useRoomInvitations(): RoomInvitationsState & { store: RoomInvitationsStore } {
  const store = roomInvitationsStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const accountId = cachedSessionSnapshot()?.accountId ?? null;
  useEffect(() => { void store.refresh(); }, [store, accountId]);
  return { ...state, store };
}
