import assert from 'node:assert/strict';

import { applyBrowserCanonicalCommand } from '@web/runtime/browserCanonicalCommands';
import { createCanonicalSessionReadModel } from '../../src/features/canonical/sessionReadModel';
import { buildParticipantSpaces } from '../../src/features/chat/participantSpaces';
import type { CloudAuthClient, CloudPublicProfile } from '../../src/features/cloud/authClient';
import { cloudMessageFromChatSync } from '../../src/features/cloud/chatSyncMapping';
import type { ChatSyncConversation, ChatSyncMember, ChatSyncMessage } from '../../src/features/cloud/chatSyncTypes';
import { buildCloudAuthError } from '../../src/features/cloud/cloudAuthError';
import {
  mergeOpenCanonicalSessionFastResultIntoLocalState,
  upsertCanonicalIdentityIntoLocalState,
} from '../../src/features/cloud/cloudCanonicalStateMerge';
import { browserGroupCanonicalPersistence } from '../../src/features/cloud/cloudGroupCanonicalPersistence';
import { cloudGroupCatalogRow } from '../../src/features/cloud/cloudGroupCatalog';
import { encodeCloudGroupControl, parseCloudGroupControl, type CloudGroupControlEnvelope } from '../../src/features/cloud/cloudGroupMessages';
import { applyCloudGroupSessionControl } from '../../src/features/cloud/cloudGroupSessionControl';
import {
  resolveAuthorizedCloudGroupSessionTitleSnapshot,
  resolveCloudGroupAdminSnapshot,
} from '../../src/features/cloud/cloudGroupSessionPolicy';
import { cleanCloudText, cloudObjectContent } from '../../src/features/cloud/cloudValue';
import { __setSessionBackendForTests } from '../../src/features/cloud/session';
import type { CanonicalSessionState } from '../../src/kordi-app/types';
import { STAND_IN, syncMember, VIEWER, viewerAccount } from './deletedAccountChatFixtures';

/** A web window of Rowan's that holds a group, driven through the real group pipeline and browser store. */
export const GROUP = 'session:group:weekend';
export const CONVERSATION_ID = '019d0000-0000-7000-8000-0000000000b1';
export const LEE = 'acct_lee';
export const KIM = 'acct_kim';
export const MAYA = 'acct_maya';
export const DELETED_AT = '2026-11-18T10:00:00Z';

export function profile(accountId: string, displayName: string): CloudPublicProfile {
  return { accountId, displayName, avatarUrl: null, nodeId: null, isContact: true, isSelf: false };
}

export const names: Record<string, string> = { [VIEWER]: 'Rowan Sample', [LEE]: 'Lee Sample', [KIM]: 'Kim Sample', [MAYA]: 'Maya Sample' };

export function member(accountId: string, state: 'active' | 'left' = 'active', overrides: Partial<ChatSyncMember> = {}) {
  return syncMember(accountId, state, { display_name: names[accountId] ?? null, ...overrides });
}

export function groupConversation(version: number, members: ChatSyncMember[], updatedAt: string): ChatSyncConversation {
  return {
    id: CONVERSATION_ID, kind: 'group', shared_title: null, version, created_by_account_id: VIEWER,
    legacy_session_id: GROUP, group_title: 'Weekend', latest_message_sequence: 4,
    created_at: '2026-11-01T09:00:00Z', updated_at: updatedAt, members, closed: null,
    preferences: { conversation_id: CONVERSATION_ID, account_id: VIEWER, personal_title: null, version: 1 },
  };
}


export const beforeDeletion = groupConversation(1, [member(VIEWER, 'active', { role: 'owner' }), member(LEE), member(KIM), member(MAYA)], '2026-11-01T09:00:00Z');
// The deleted account's row is gone; the stand-in joined as a member who left.
export const afterDeletion = groupConversation(2, [
  member(VIEWER, 'active', { role: 'owner' }), member(LEE), member(KIM),
  syncMember(STAND_IN, 'left', { display_name: 'Deleted account' }),
], DELETED_AT);

export function emptyState(): CanonicalSessionState {
  return {
    storagePath: '/tmp/deleted-account-group.sqlite3',
    profile: {
      id: 'profile:rowan', displayName: 'Rowan Sample', humanIdentityId: `human:${VIEWER}`,
      activeAgentIdentityId: null, storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1,
    },
    identities: [], sessions: [], participants: [], messages: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
  } as CanonicalSessionState;
}

/** A web window: the browser store, the window's own copy of it, and what it has fetched. */
export function webWindow(profiles: CloudPublicProfile[], missing: readonly string[] = [MAYA]) {
  const store = emptyState();
  const fetched: string[] = [];
  const window = {
    store,
    local: emptyState() as CanonicalSessionState | null,
    fetched,
    profileCache: new Map(profiles.map((entry) => [entry.accountId, entry])),
    persistence: browserGroupCanonicalPersistence(async (command, args) => (
      structuredClone(applyBrowserCanonicalCommand(store, command, args, 1_000)) as never
    )),
    client: {
      getProfile: async (_token: string, accountId: string) => {
        fetched.push(accountId);
        if (missing.includes(accountId)) {
          throw buildCloudAuthError(404, { error: { code: 'account_missing', message: 'No account found with that Kordi ID.' } }, 'Could not load profile.');
        }
        return profile(accountId, names[accountId] ?? accountId);
      },
    } as unknown as CloudAuthClient,
    setState(update: CanonicalSessionState | null | ((current: CanonicalSessionState | null) => CanonicalSessionState | null)) {
      window.local = typeof update === 'function' ? update(window.local) : update;
    },
  };
  return window;
}

export type WebWindow = ReturnType<typeof webWindow>;

/** One live row through the real group pipeline, as a message event in an open window applies it. */
export async function applyEnvelope(window: WebWindow, envelope: CloudGroupControlEnvelope, wire = {
  messageId: envelope.message?.id ?? 'wire', fromAccountId: envelope.actor.accountId, toAccountId: VIEWER, body: '',
  createdAt: DELETED_AT, deliveredAt: null, readAt: null, direction: 'incoming' as const, sessionId: GROUP,
}, useCatalogProfiles = false) {
  return applyCloudGroupSessionControl({
    persistence: window.persistence,
    cloudMessage: wire,
    envelope,
    useCatalogProfiles,
    runtime: { account: viewerAccount, client: window.client, profileCache: window.profileCache, sessionPreparationCache: new Map() },
    canonical: { getState: () => window.local, setState: (update) => window.setState(update) },
    stateOps: {
      objectContent: cloudObjectContent,
      cleanText: cleanCloudText,
      resolveAdminSnapshot: resolveCloudGroupAdminSnapshot,
      resolveSessionTitle: resolveAuthorizedCloudGroupSessionTitleSnapshot,
      upsertIdentity: upsertCanonicalIdentityIntoLocalState,
      mergeOpenSession: mergeOpenCanonicalSessionFastResultIntoLocalState,
    },
  });
}

export async function applyMessage(window: WebWindow, message: ChatSyncMessage, conversation: ChatSyncConversation, useCatalogProfiles = false) {
  const wire = cloudMessageFromChatSync(message, conversation, VIEWER);
  const envelope = parseCloudGroupControl(wire.body);
  assert.ok(envelope, 'a group message becomes a group row');
  await applyEnvelope(window, envelope, wire, useCatalogProfiles);
  return envelope;
}

/** The members the group's sidebar tile draws, by name. */
export function groupTile(state: CanonicalSessionState | null) {
  const conversations = createCanonicalSessionReadModel(state)?.buildChatConversations([], (_messages, fallback) => fallback ?? '') ?? [];
  const space = buildParticipantSpaces(conversations).find((candidate) => candidate.kind === 'group');
  assert.ok(space, 'the group is listed');
  return space.participants.filter((participant) => participant.kind === 'human').map((participant) => participant.name).sort();
}

export function staleCopy(text: string, participants: string[]) {
  const person = (accountId: string) => ({ accountId, displayName: names[accountId] ?? accountId, avatarUrl: null, role: 'member' });
  return encodeCloudGroupControl({
    kind: 'group-message', groupId: GROUP, createdByAccountId: VIEWER, actor: person(LEE),
    participants: participants.map(person),
    message: { id: 'msg:stale-copy', senderAccountId: LEE, text, createdAtMs: 1, senderKind: 'human', senderDisplayName: 'Lee Sample' },
  } as CloudGroupControlEnvelope);
}

export function withSession(run: () => Promise<void>) {
  __setSessionBackendForTests({
    load: async () => ({ token: 'rowan-token', accountId: VIEWER, expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
  return run().finally(() => __setSessionBackendForTests(null));
}

export const STUDIO = { ...afterDeletion, shared_title: 'Studio plans', group_title: 'Studio' };

/** A catalog row as a window loads it: the session shell from the server's member list. */
export async function loadCatalog(window: WebWindow, conversation: ChatSyncConversation) {
  const row = cloudGroupCatalogRow(conversation, VIEWER);
  assert.ok(row);
  await applyCloudGroupSessionControl({
    persistence: window.persistence, cloudMessage: row.wire, envelope: row.envelope, historyReplay: true,
    catalogGroupTitle: conversation.group_title, catalogGroupAvatar: conversation.group_avatar,
    runtime: { account: viewerAccount, client: window.client, profileCache: window.profileCache, sessionPreparationCache: new Map() },
    canonical: { getState: () => window.local, setState: (update) => window.setState(update) },
    stateOps: {
      objectContent: cloudObjectContent, cleanText: cleanCloudText,
      resolveAdminSnapshot: resolveCloudGroupAdminSnapshot, resolveSessionTitle: resolveAuthorizedCloudGroupSessionTitleSnapshot,
      upsertIdentity: upsertCanonicalIdentityIntoLocalState, mergeOpenSession: mergeOpenCanonicalSessionFastResultIntoLocalState,
    },
  });
}

export function channel(state: CanonicalSessionState | null) {
  const session = state?.sessions.find((candidate) => candidate.id === GROUP);
  assert.ok(session);
  const metadata = session.metadata as Record<string, unknown>;
  const name = createCanonicalSessionReadModel(state)?.buildChatConversations([], (_messages, fallback) => fallback ?? '')
    .find((conversation) => conversation.canonicalSessionId === GROUP)?.name;
  return { name, creator: session.createdByIdentityId, admins: metadata.adminIdentityIds as string[] };
}
