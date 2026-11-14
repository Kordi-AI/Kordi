// Group invitations outside the Grounding page: "Alex invited you to Infrastructure and CI"
// in Contacts › Requests and in the Contacts badge. Room invitations (`kind: "room"`) come from a
// room's group; person invitations (`kind: "group"`, no code) come from someone you share
// Grounding with. The list refreshes on Grounding room and invitation hints (a new invitation, a
// join or a decline on another device), when the window regains focus, and when the account
// changes. It stays small: the sidebar imports it outside the lazy page.

import { useEffect, useSyncExternalStore } from 'react';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { CloudAuthError } from '@/features/cloud/cloudAuthError';
import { cachedSessionSnapshot, CLOUD_SESSION_CHANGED_EVENT, loadSession } from '@/features/cloud/session';
import { subscribeInvitationHints, subscribeRoomHints } from './roomHints';

export type RoomGroupInvitation = {
  invitationRef: string;
  /** "room" for a room's group (answered through the room's code), "group" for a person invitation. */
  kind: 'room' | 'group';
  code: string | null;
  /** The room both people share; empty when there is none ("from Grounding"). */
  roomName: string;
  groupSpaceId: string;
  conversationId: string | null;
  name: string;
  from: { accountId: string; name: string; avatarUrl: string | null };
  /** People already in the group, creator first, up to eight. */
  members: Array<{ accountId: string; name: string; avatarUrl: string | null }>;
  memberCount: number;
  createdAt: string;
};

export type RoomInvitationsState = {
  invitations: RoomGroupInvitation[];
  /** The invitation an answer is being sent for. */
  busyRef: string | null;
  error: string | null;
  /** The invitation open in the Contacts detail pane, kept after it is answered. */
  selected: RoomGroupInvitation | null;
  /** How the open invitation was answered. */
  outcome: 'joined' | 'declined' | null;
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

function person(value: unknown): RoomGroupInvitation['from'] | null {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const accountId = text(row?.accountId);
  return accountId ? { accountId, name: text(row?.name) ?? 'Someone', avatarUrl: text(row?.avatarUrl) } : null;
}

export function normalizeRoomInvitation(value: unknown): RoomGroupInvitation | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const from = person(row.from);
  const invitationRef = text(row.invitationRef);
  const kind = row.kind === 'group' ? 'group' : 'room';
  const code = text(row.code);
  const groupSpaceId = text(row.groupSpaceId);
  // A room invitation is answered through its room, so it needs the code.
  if (!invitationRef || (kind === 'room' && !code) || !groupSpaceId || !from) return null;
  const members = Array.isArray(row.members) ? row.members.map(person).filter((member) => member !== null) : [];
  return {
    invitationRef, kind, code, groupSpaceId, from, members,
    roomName: text(row.roomName) ?? '',
    conversationId: text(row.conversationId),
    name: text(row.name) ?? 'a group',
    memberCount: typeof row.memberCount === 'number' ? row.memberCount : members.length,
    createdAt: text(row.createdAt) ?? '',
  };
}

/** Room invitations answer through their room; person invitations through their own route. */
export function answerPath(invitation: RoomGroupInvitation, action: 'join' | 'decline'): string {
  const ref = encodeURIComponent(invitation.invitationRef);
  return invitation.kind === 'room' && invitation.code
    ? `/v1/cloud/common-ground/rooms/${encodeURIComponent(invitation.code)}/invitations/${ref}/${action}`
    : `/v1/cloud/common-ground/group-invitations/${ref}/${action}`;
}

const EMPTY: RoomInvitationsState = { invitations: [], busyRef: null, error: null, selected: null, outcome: null };

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
      set({ invitations: [], error: null, selected: null, outcome: null });
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
      const path = answerPath(invitation, action);
      const joined = await transport.request<{ groupSpaceId?: string; conversationId?: string } | null>(
        path,
        { method: 'POST', headers: { authorization: `Bearer ${session.token}` } },
        action === 'join' ? 'Could not join the group.' : 'Could not decline the invitation.',
      );
      set({
        invitations: state.invitations.filter((row) => row.invitationRef !== invitation.invitationRef),
        ...(state.selected?.invitationRef === invitation.invitationRef ? { outcome: action === 'join' ? 'joined' as const : 'declined' as const } : {}),
      });
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
    /** Opens an invitation in the Contacts detail pane, or closes it with null. */
    select: (invitation: RoomGroupInvitation | null) => set({ selected: invitation, outcome: null, error: null }),
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
    subscribeInvitationHints(() => { void store.refresh(); });
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, () => { void store.refresh(); });
    window.addEventListener('focus', () => { void store.refresh(); });
  }
  return shared;
}

/** The signed-in account's pending group invitations; loads them on first use. */
export function useRoomInvitations(): RoomInvitationsState & { store: RoomInvitationsStore } {
  const store = roomInvitationsStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const accountId = cachedSessionSnapshot()?.accountId ?? null;
  useEffect(() => { void store.refresh(); }, [store, accountId]);
  return { ...state, store };
}
