import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { cloudContactToContact } from '../src/features/cloud/cloudContactMapping';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import type { ChatSyncConversation, ChatSyncMessage } from '../src/features/cloud/chatSyncTypes';
import { cloudDirectPersonSessionId } from '../src/features/collaboration/conversationIds';
import { collectSessionTrace, type CollectSessionTraceDeps } from '../src/features/sessionExport/collectSessionTrace';
import type { CloudHistoryPage, CloudSessionTraceDeps } from '../src/features/sessionExport/cloudSessionTrace';
import { serializeSessionTrace, sessionTraceFileName, type SessionTraceInput } from '../src/features/sessionExport/serializeSessionTrace';
import { sessionTraceParticipants } from '../src/features/sessionExport/sessionTraceMetadata';
import type {
  CanonicalMessagePage,
  CanonicalSessionMessage,
  CanonicalSessionState,
  CanonicalTimelineCursor,
  DesktopChatSessionDetail,
  Message,
} from '../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

// Synthetic people only: Alex exports, Maya is the other member.
const BASE_MS = Date.UTC(2026, 10, 14, 9, 30, 0);
const ALEX = 'acct_alex';
const MAYA = 'acct_maya';
const account: CloudAccount = {
  accountId: ALEX, displayName: 'Alex', primaryEmail: 'alex@example.test',
  avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: 'node_alex', passwordSet: true,
};

function lines(text: string) {
  assert.ok(text.endsWith('\n'));
  return text.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function traceInput(messages: Message[], overrides: Partial<SessionTraceInput> = {}): SessionTraceInput {
  return {
    exportedAt: new Date(BASE_MS + 60_000),
    session: { id: 'session:trace', kind: 'self-agent', title: 'Trip planning', createdAtMs: BASE_MS },
    participants: [
      { id: 'human:acct_alex', name: 'Alex', kind: 'human', role: 'self' },
      { id: 'agent:alex', name: 'Kordi', kind: 'agent', role: 'owned-agent', ownerId: 'human:acct_alex' },
    ],
    exportedBy: ALEX,
    viewerIdentityId: 'human:acct_alex',
    messages,
    complete: true,
    ...overrides,
  };
}

test('serializeSessionTrace writes the header, messages in order, attachment metadata and redacted tool payloads', () => {
  const messages: Message[] = [
    {
      id: 'm1', role: 'user', sender: 'Me', sourceSenderLabel: 'Alex', isOwnMessage: true,
      text: 'Find a hotel near the venue', time: '9:31', timestampMs: BASE_MS + 1_000,
      attachments: [{
        kind: 'image', name: 'venue.png', mimeType: 'image/png', sizeBytes: 2048,
        localPath: '/Users/example/Pictures/venue.png', previewUrl: 'data:image/png;base64,AAAA',
        downloadUrl: 'https://example.test/download/venue.png',
      }],
    },
    {
      id: 'm2', role: 'owned-agent', sender: 'Kordi', senderIdentityId: 'agent:alex', senderType: 'agent',
      text: '', time: '9:32', timestampMs: BASE_MS + 2_000, replyToMessageId: 'm1',
      turn: {
        id: 'turn-2', sessionId: 'session:trace', prompt: '', status: 'complete', message: 'Complete',
        assistantText: 'The Harbor Hotel is a short walk away.',
        thinkingText: 'Use token=abc123secret to call the API',
        segments: [{ id: 's1', kind: 'tool', toolId: 'tool-1' }, { id: 's2', kind: 'text', text: 'The Harbor Hotel is a short walk away.' }],
        tools: [{
          id: 'tool-1', name: 'web_search', status: 'done',
          arguments: '{"query":"hotels","header":"Bearer sk-livesecretvalue123"}',
          liveOutput: '', resultText: 'api_key=sk-abcdefghijklmnop Harbor Hotel', isError: false,
        }],
        completed: true, succeeded: true, startedAtMs: BASE_MS + 1_500, completedAtMs: BASE_MS + 2_000,
      },
    },
  ];
  const text = serializeSessionTrace(traceInput(messages));
  const [header, user, agent] = lines(text);

  assert.deepEqual(Object.keys(header), ['type', 'schema', 'version', 'exported_at', 'session', 'participants', 'exported_by', 'message_count', 'subsession_count', 'complete']);
  assert.equal(header.schema, 'kordi.session-trace');
  assert.equal(header.version, 1);
  assert.equal(header.exported_at, '2026-11-14T09:31:00.000Z');
  assert.deepEqual(header.session, { id: 'session:trace', kind: 'self-agent', title: 'Trip planning', created_at: '2026-11-14T09:30:00.000Z' });
  assert.deepEqual(header.participants, [
    { id: 'human:acct_alex', name: 'Alex', kind: 'human', role: 'self' },
    { id: 'agent:alex', name: 'Kordi', kind: 'agent', role: 'owned-agent', owner_id: 'human:acct_alex' },
  ]);
  assert.equal(header.message_count, 2);
  assert.equal(header.subsession_count, 0);
  assert.equal(header.complete, true);

  assert.deepEqual(Object.keys(user), ['type', 'session_id', 'id', 'seq', 'timestamp', 'sender', 'role', 'text', 'attachments']);
  assert.equal(user.session_id, 'session:trace');
  assert.deepEqual(user.sender, { id: 'human:acct_alex', name: 'Alex', kind: 'human' });
  assert.equal(user.role, 'user');
  assert.equal(user.seq, 1);
  assert.deepEqual(user.attachments, [{ name: 'venue.png', mime: 'image/png', size: 2048 }]);

  assert.deepEqual(Object.keys(agent), ['type', 'session_id', 'id', 'seq', 'timestamp', 'sender', 'role', 'text', 'reply_to', 'agent_turn']);
  assert.equal(agent.seq, 2);
  assert.equal(agent.role, 'assistant');
  assert.equal(agent.text, 'The Harbor Hotel is a short walk away.');
  assert.equal(agent.reply_to, 'm1');
  const turn = agent.agent_turn as Record<string, unknown>;
  assert.deepEqual(Object.keys(turn), ['status', 'started_at', 'completed_at', 'thinking', 'segments', 'tools']);
  assert.equal(turn.thinking, 'Use token=[redacted] to call the API');
  assert.deepEqual(turn.segments, [{ id: 's1', kind: 'tool', tool_id: 'tool-1' }, { id: 's2', kind: 'text', text: 'The Harbor Hotel is a short walk away.' }]);
  assert.deepEqual(turn.tools, [{
    id: 'tool-1', name: 'web_search', status: 'done',
    arguments: '{"query":"hotels","header":"Bearer [redacted]"}',
    result: 'api_key=[redacted] Harbor Hotel', is_error: false,
  }]);

  // Never file bytes, preview data, download links, local paths, secrets or nulls.
  for (const forbidden of ['/Users/example', 'base64', 'download/venue', 'abc123secret', 'sk-livesecret', 'sk-abcdefgh', ':null']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('serializeSessionTrace omits absent optionals and keeps a monotonic fallback timestamp', () => {
  const text = serializeSessionTrace(traceInput([
    { role: 'system', text: 'Alex renamed the chat', time: '' },
    { id: 'm2', role: 'person', sender: 'Maya', senderIdentityId: 'human:acct_maya', text: 'Hi', time: '', timestampMs: BASE_MS + 5_000 },
  ], { appVersion: '0.0.2-beta.9', session: { id: 'session:x', kind: 'group', title: 'Launch', project: 'Kordi Web' } }));
  const [header, notice, maya] = lines(text);
  assert.equal(header.app_version, '0.0.2-beta.9');
  assert.deepEqual(header.session, { id: 'session:x', kind: 'group', title: 'Launch', created_at: '2026-11-14T09:30:05.000Z', project: 'Kordi Web' });
  assert.equal(notice.id, 'message-1');
  assert.deepEqual(notice.sender, { id: 'system', name: 'System', kind: 'system' });
  assert.equal(notice.role, 'system');
  assert.equal(notice.timestamp, '2026-11-14T09:30:05.000Z');
  assert.equal('attachments' in notice || 'agent_turn' in notice || 'reply_to' in notice || 'kind' in notice, false);
  assert.deepEqual(maya.sender, { id: 'human:acct_maya', name: 'Maya', kind: 'human' });
});

test('sessionTraceFileName slugs the title and stamps local time', () => {
  const at = new Date(2026, 10, 14, 9, 5);
  assert.equal(sessionTraceFileName('Café: Launch plan / Q4!', at), 'kordi-trace-cafe-launch-plan-q4-20261114-0905.jsonl');
  assert.equal(sessionTraceFileName('  ', at), 'kordi-trace-session-20261114-0905.jsonl');
});

test('sessionTraceParticipants falls back to the transcript senders', () => {
  const participants = sessionTraceParticipants(null, [
    { role: 'user', sender: 'Me', sourceSenderLabel: 'Alex', text: 'a', time: '' },
    { role: 'owned-agent', sender: 'Kordi', text: '', time: '' },
    { role: 'system', text: 'notice', time: '' },
    { role: 'user', sender: 'Me', sourceSenderLabel: 'Alex', text: 'b', time: '' },
  ], { exportedBy: ALEX, viewerIdentityId: 'human:acct_alex' });
  assert.deepEqual(participants, [
    { id: 'human:acct_alex', name: 'Alex', kind: 'human' },
    { id: 'agent:kordi', name: 'Kordi', kind: 'agent' },
  ]);
});

// Canonical store fixtures: a group channel between Alex and Maya.
const GROUP_ID = 'session:group:trace-launch';
const groupState = {
  storagePath: '',
  profile: { id: 'profile', displayName: 'Alex', humanIdentityId: 'human:acct_alex', storageRoot: '', createdAtMs: 1, updatedAtMs: 1 },
  identities: [
    { id: 'human:acct_alex', kind: 'human', displayName: 'Alex', source: 'cloud', humanId: ALEX, avatarKey: 'alex', createdAtMs: 1, updatedAtMs: 1 },
    { id: 'human:acct_maya', kind: 'human', displayName: 'Maya', source: 'cloud', humanId: MAYA, avatarKey: 'maya', createdAtMs: 1, updatedAtMs: 1 },
  ],
  sessions: [{ id: GROUP_ID, kind: 'group', title: 'Launch', status: 'active', createdByIdentityId: 'human:acct_alex',
    metadata: {}, createdAtMs: BASE_MS, updatedAtMs: BASE_MS, lastMessageAtMs: BASE_MS }],
  participants: [
    { sessionId: GROUP_ID, identityId: 'human:acct_alex', role: 'self', state: 'active', addedAtMs: 1 },
    { sessionId: GROUP_ID, identityId: 'human:acct_maya', role: 'person', state: 'active', addedAtMs: 1 },
  ],
  messages: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
} as unknown as CanonicalSessionState;

function canonicalRow(index: number): CanonicalSessionMessage {
  const fromMaya = index % 2 === 0;
  return {
    id: `msg-${index}`, sessionId: GROUP_ID,
    senderIdentityId: fromMaya ? 'human:acct_maya' : 'human:acct_alex',
    senderRole: fromMaya ? 'person' : 'user', messageKind: 'text',
    contentText: `Message ${index}`, content: { conversationSequence: index },
    status: 'sent', sequenceNum: index, createdAtMs: BASE_MS + index * 1_000, updatedAtMs: BASE_MS + index * 1_000,
    sourceTransport: 'cloud-group', sourceEventId: `cloud-group:wire-${index}`,
  };
}

function compareTimeline(left: CanonicalTimelineCursor, right: CanonicalTimelineCursor) {
  return left.createdAtMs - right.createdAtMs || left.sequenceNum - right.sequenceNum || left.id.localeCompare(right.id);
}

/** A canonical store that pages in timeline order, newest page first, like the native command. */
function canonicalStore(rows: CanonicalSessionMessage[], options: { failOnCall?: number } = {}) {
  const calls: Array<{ before: CanonicalTimelineCursor | null; limit: number }> = [];
  const fetchPage = (sessionId: string, before: CanonicalTimelineCursor | null, limit: number): Promise<CanonicalMessagePage> => {
    calls.push({ before, limit });
    if (options.failOnCall === calls.length) return Promise.reject(new Error('database is locked'));
    const eligible = rows
      .filter((row) => row.sessionId === sessionId && (!before || compareTimeline(row, before) < 0))
      .sort(compareTimeline);
    const messages = eligible.slice(-limit);
    return Promise.resolve({
      sessionId, messages, hasOlder: eligible.length > limit, timelineOrder: true,
      oldestSequenceNum: messages[0]?.sequenceNum ?? null, newestSequenceNum: messages.at(-1)?.sequenceNum ?? null,
    });
  };
  return { calls, fetchPage };
}

function deps(overrides: Partial<CollectSessionTraceDeps> & Pick<CollectSessionTraceDeps, 'canonical'>): CollectSessionTraceDeps {
  return { runtime: null, cloud: null, localAgentLabel: 'Kordi', ...overrides };
}

test('collectSessionTrace pages the whole canonical history in order and stops at the oldest page', async () => {
  const rows = Array.from({ length: 450 }, (_, index) => canonicalRow(index + 1));
  const store = canonicalStore([...rows].reverse());
  const trace = await collectSessionTrace(GROUP_ID, deps({ canonical: { state: groupState, fetchPage: store.fetchPage } }));

  assert.equal(trace.source, 'canonical');
  assert.equal(trace.complete, true);
  assert.equal(store.calls.length, 3);
  assert.deepEqual(store.calls.map((call) => call.limit), [200, 200, 200]);
  assert.equal(store.calls[0].before, null);
  assert.deepEqual(store.calls[1].before, { id: 'msg-251', createdAtMs: BASE_MS + 251_000, sequenceNum: 251 });
  assert.deepEqual(store.calls[2].before, { id: 'msg-51', createdAtMs: BASE_MS + 51_000, sequenceNum: 51 });
  assert.equal(trace.messages.length, 450);
  assert.deepEqual(trace.messages.map((message) => message.text), rows.map((row) => row.contentText));
});

test('collectSessionTrace rejects when a canonical page fails or the cursor stalls', async () => {
  const rows = Array.from({ length: 450 }, (_, index) => canonicalRow(index + 1));
  const failing = canonicalStore(rows, { failOnCall: 2 });
  await assert.rejects(
    collectSessionTrace(GROUP_ID, deps({ canonical: { state: groupState, fetchPage: failing.fetchPage } })),
    /database is locked/,
  );
  const stalled = (): Promise<CanonicalMessagePage> => Promise.resolve({
    sessionId: GROUP_ID, messages: [canonicalRow(9)], hasOlder: true, oldestSequenceNum: 9, newestSequenceNum: 9,
  });
  await assert.rejects(
    collectSessionTrace(GROUP_ID, deps({ canonical: { state: groupState, fetchPage: stalled } })),
    /did not advance/,
  );
});

const groupConversation: ChatSyncConversation = {
  id: 'conv-trace-launch', kind: 'group', shared_title: 'Launch', version: 1, created_by_account_id: ALEX,
  legacy_session_id: GROUP_ID, group_space_id: GROUP_ID, group_title: 'Launch', latest_message_sequence: 6,
  created_at: new Date(BASE_MS).toISOString(), updated_at: new Date(BASE_MS).toISOString(),
  members: [ALEX, MAYA].map((accountId) => ({
    account_id: accountId, display_name: accountId === ALEX ? 'Alex' : 'Maya', role: 'member',
    membership_state: 'active', version: 1, last_delivered_sequence: 6, last_read_sequence: 6,
    joined_at: new Date(BASE_MS).toISOString(), left_at: null,
  })),
  preferences: { conversation_id: 'conv-trace-launch', account_id: ALEX, personal_title: null, version: 1 },
};

function serverRow(conversationId: string, sequence: number, sender: string, text: string, extra: Partial<ChatSyncMessage> = {}): ChatSyncMessage {
  return {
    id: `wire-${sequence}`, client_message_id: `client-${sequence}`, conversation_id: conversationId,
    conversation_sequence: sequence, sender_account_id: sender, kind: 'text',
    content: { schema: 1, blocks: [{ type: 'text', text }] }, reply_to_message_id: null, attachment_ids: [],
    version: 1, generation_status: null, provider_response_id: null,
    created_at: new Date(BASE_MS + sequence * 1_000).toISOString(), edited_at: null, deleted_at: null,
    ...extra,
  };
}

function cloudDeps(conversation: ChatSyncConversation, pages: CloudHistoryPage[], extra: Partial<CloudSessionTraceDeps> = {}) {
  const calls: Array<{ conversationId: string; before: number | undefined; limit: number }> = [];
  const cloud: CloudSessionTraceDeps = {
    account, contacts: [],
    findConversation: (sessionId) => Promise.resolve((conversation.legacy_session_id ?? conversation.id) === sessionId ? conversation : null),
    fetchPage: (conversationId, before, limit) => {
      calls.push({ conversationId, before, limit });
      const page = pages[calls.length - 1];
      return page ? Promise.resolve(page) : Promise.reject(new Error('server unavailable'));
    },
    ...extra,
  };
  return { calls, cloud };
}

test('collectSessionTrace completes a group from every server page until has_more is false', async () => {
  const rows = (sequences: number[]) => sequences.map((sequence) => serverRow(
    groupConversation.id, sequence, sequence % 2 === 0 ? MAYA : ALEX, `Message ${sequence}`,
  ));
  const { calls, cloud } = cloudDeps(groupConversation, [
    { messages: [...rows([4, 5]), serverRow(groupConversation.id, 6, MAYA, 'Removed', { deleted_at: new Date(BASE_MS).toISOString() })], nextBeforeSequence: 4, hasMore: true },
    { messages: rows([1, 2, 3]), nextBeforeSequence: null, hasMore: false },
  ]);
  // This device cached only the first three messages.
  const store = canonicalStore([1, 2, 3].map(canonicalRow));
  const trace = await collectSessionTrace(GROUP_ID, deps({ canonical: { state: groupState, fetchPage: store.fetchPage }, cloud }));

  assert.equal(trace.source, 'cloud');
  assert.deepEqual(calls, [
    { conversationId: groupConversation.id, before: undefined, limit: 200 },
    { conversationId: groupConversation.id, before: 4, limit: 200 },
  ]);
  assert.deepEqual(trace.messages.map((message) => message.text), ['Message 1', 'Message 2', 'Message 3', 'Message 4', 'Message 5']);
  assert.deepEqual(trace.messages.slice(3).map((message) => message.role), ['person', 'user']);
  const [, , , , mayaLine, alexLine] = lines(serializeSessionTrace(traceInput(trace.messages)));
  assert.deepEqual(mayaLine.sender, { id: 'human:acct_maya', name: 'Maya', kind: 'human' });
  assert.deepEqual(alexLine.sender, { id: 'human:acct_alex', name: 'Alex', kind: 'human' });
  assert.deepEqual([mayaLine.seq, alexLine.seq], [4, 5]);
});

test('collectSessionTrace rejects when a server page fails or its cursor stalls', async () => {
  const store = canonicalStore([1].map(canonicalRow));
  const failing = cloudDeps(groupConversation, [
    { messages: [serverRow(groupConversation.id, 3, ALEX, 'Message 3')], nextBeforeSequence: 3, hasMore: true },
  ]);
  await assert.rejects(
    collectSessionTrace(GROUP_ID, deps({ canonical: { state: groupState, fetchPage: store.fetchPage }, cloud: failing.cloud })),
    /server unavailable/,
  );
  const stalled = cloudDeps(groupConversation, [
    { messages: [], nextBeforeSequence: 5, hasMore: true },
    { messages: [], nextBeforeSequence: 5, hasMore: true },
  ]);
  await assert.rejects(
    collectSessionTrace(GROUP_ID, deps({ canonical: { state: groupState, fetchPage: store.fetchPage }, cloud: stalled.cloud })),
    /did not advance/,
  );
});

test('a direct chat exports the other owner\'s agent reply without its private trace', async () => {
  const sessionId = cloudDirectPersonSessionId(ALEX, MAYA);
  const conversation: ChatSyncConversation = {
    ...groupConversation, id: 'conv-trace-direct', kind: 'direct', legacy_session_id: sessionId,
    group_space_id: null, group_title: null, shared_title: null,
    preferences: { ...groupConversation.preferences, conversation_id: 'conv-trace-direct' },
  };
  const request = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1, kind: 'message', text: '@Maya\'s Kordi summarize the launch notes',
    targetCloudAgentId: `cloud-agent:${MAYA}`, targetCloudAgentName: 'Kordi', targetCloudAgentOwnerAccountId: MAYA,
  });
  const reply = encodeCloudAgentResponse({
    requestId: 'wire-2', text: 'The launch moves to Friday.', deliveryState: 'complete',
    execution: {
      phase: 'complete', summary: 'Execution complete', steps: [], thinkingText: 'private reasoning of Maya agent',
      tools: [{ id: 'tool-private', name: 'read_private_notes', status: 'done', arguments: '{"path":"notes"}', liveOutput: '', resultText: 'private notes body', isError: false }],
      updatedAtMs: BASE_MS + 3_000, completed: true,
    },
  });
  const { cloud } = cloudDeps(conversation, [{
    messages: [
      serverRow(conversation.id, 1, MAYA, 'Hi Alex'),
      serverRow(conversation.id, 2, ALEX, request),
      serverRow(conversation.id, 3, MAYA, reply),
    ],
    nextBeforeSequence: null,
    hasMore: false,
  }], {
    contacts: [cloudContactToContact({ accountId: MAYA, displayName: 'Maya', avatarUrl: null, nodeId: null, createdAt: new Date(BASE_MS).toISOString() })],
  });
  const store = canonicalStore([]);
  const trace = await collectSessionTrace(sessionId, deps({ canonical: { state: groupState, fetchPage: store.fetchPage }, cloud }));
  const text = serializeSessionTrace(traceInput(trace.messages));

  assert.equal(trace.source, 'cloud');
  assert.match(text, /Hi Alex/);
  assert.match(text, /summarize the launch notes/);
  assert.match(text, /The launch moves to Friday\./);
  for (const forbidden of ['private reasoning', 'read_private_notes', 'private notes body']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('the owner\'s own cloud agent session exports its owner-visible trace', async () => {
  const sessionId = 'session:trace-self-agent';
  const conversation: ChatSyncConversation = {
    ...groupConversation, id: 'conv-trace-self', kind: 'direct', legacy_session_id: sessionId,
    group_space_id: null, group_title: null, shared_title: 'Weather',
    members: groupConversation.members.filter((member) => member.account_id === ALEX),
    preferences: { ...groupConversation.preferences, conversation_id: 'conv-trace-self' },
  };
  const request = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1, kind: 'message', text: 'What is the weather?',
    targetCloudAgentId: `cloud-agent:${ALEX}`, targetCloudAgentName: 'Kordi', targetCloudAgentOwnerAccountId: ALEX,
  });
  const reply = encodeCloudAgentResponse({
    requestId: 'wire-1', text: 'Sunny all day.', deliveryState: 'complete',
    execution: {
      phase: 'complete', summary: 'Execution complete', steps: [], thinkingText: 'Check the forecast',
      tools: [{ id: 'tool-weather', name: 'web_search', status: 'done', arguments: '{"query":"weather"}', liveOutput: '', resultText: 'Sunny', isError: false }],
      startedAtMs: BASE_MS + 1_500, updatedAtMs: BASE_MS + 2_000, completed: true,
    },
  });
  const { cloud } = cloudDeps(conversation, [{
    messages: [serverRow(conversation.id, 1, ALEX, request), serverRow(conversation.id, 2, ALEX, reply)],
    nextBeforeSequence: null,
    hasMore: false,
  }]);
  const trace = await collectSessionTrace(sessionId, deps({ canonical: { state: groupState, fetchPage: canonicalStore([]).fetchPage }, cloud }));
  const agentLine = lines(serializeSessionTrace(traceInput(trace.messages))).find((line) => line.role === 'assistant');
  assert.ok(agentLine);
  assert.equal(agentLine.text, 'Sunny all day.');
  const turn = agentLine.agent_turn as Record<string, unknown>;
  assert.equal(turn.thinking, 'Check the forecast');
  assert.deepEqual(turn.tools, [{ id: 'tool-weather', name: 'web_search', status: 'done', arguments: '{"query":"weather"}', result: 'Sunny', is_error: false }]);
});

test('a local runtime session exports full tool calls with the runtime model', async () => {
  const sessionId = 'local-session-trace';
  const detail = {
    id: sessionId,
    messages: [
      { role: 'user', sender: 'You', text: 'List the repo files', timeLabel: '9:31', timestampMs: BASE_MS + 1_000, entryId: 'entry-1' },
      {
        role: 'assistant', sender: 'Kordi', text: 'Two files.', detail: 'anthropic/claude-test • completed',
        timeLabel: '9:32', timestampMs: BASE_MS + 2_000, entryId: 'entry-2', thinkingText: 'List with ls',
        tools: [{ id: 'call-1', name: 'bash', status: 'done', arguments: '{"command":"ls"}', liveOutput: '', resultText: 'a.txt\nb.txt', isError: false }],
      },
    ],
  } as unknown as DesktopChatSessionDetail;
  const store = canonicalStore([]);
  const trace = await collectSessionTrace(sessionId, deps({
    runtime: { fetchDetail: () => Promise.resolve(detail) },
    canonical: { state: null, fetchPage: store.fetchPage },
  }));
  assert.equal(trace.source, 'runtime');
  assert.equal(store.calls.length, 0);
  const [, user, agent] = lines(serializeSessionTrace(traceInput(trace.messages)));
  assert.equal(user.text, 'List the repo files');
  assert.equal(agent.text, 'Two files.');
  const turn = agent.agent_turn as Record<string, unknown>;
  assert.equal(turn.model, 'claude-test');
  assert.equal(turn.provider, 'anthropic');
  assert.equal(turn.thinking, 'List with ls');
  assert.deepEqual(turn.tools, [{ id: 'call-1', name: 'bash', status: 'done', arguments: '{"command":"ls"}', result: 'a.txt\nb.txt', is_error: false }]);
});
