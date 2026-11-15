import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentSubsessionTask, CloudAgentSubsession, NativeAgentSubsession } from '../src/features/cloud/agentSubsessionTypes';
import { collectSessionTrace, type CollectSessionTraceDeps } from '../src/features/sessionExport/collectSessionTrace';
import { MAX_SUBSESSION_DEPTH, MAX_SUBSESSIONS, type SubsessionTraceDeps } from '../src/features/sessionExport/collectSubsessionTraces';
import { serializeSessionTrace } from '../src/features/sessionExport/serializeSessionTrace';
import type { DesktopChatSessionDetail, DesktopChatToolSnapshot } from '../src/kordi-app/types';

// Synthetic people only: Alex exports, Maya is another member.
const BASE_MS = Date.UTC(2026, 10, 14, 9, 30, 0);
const ALEX = 'acct_alex';
const MAYA = 'acct_maya';
const MAIN = 'local-session-main';

type Line = Record<string, unknown>;

function spawnTool(id: string, sessionId: string, title: string, extra: Partial<DesktopChatToolSnapshot> = {}): DesktopChatToolSnapshot {
  return {
    id, name: 'task_operator', status: 'done', arguments: '{"action":"spawn"}', liveOutput: '', isError: false,
    resultText: `Task agent running\n\nBackground session: ${JSON.stringify({ sessionId, turnId: `turn-${sessionId}`, title, status: 'running' })}`,
    ...extra,
  };
}

function runtimeDetail(id: string, prompt: string, reply: string, tools: DesktopChatToolSnapshot[] = [], at = 0): DesktopChatSessionDetail {
  return {
    id,
    messages: [
      { role: 'user', sender: 'You', text: prompt, timeLabel: '', timestampMs: BASE_MS + at + 1_000, entryId: `${id}-entry-1` },
      {
        role: 'assistant', sender: 'Kordi', text: reply, detail: 'anthropic/claude-test • completed', timeLabel: '',
        timestampMs: BASE_MS + at + 2_000, entryId: `${id}-entry-2`, thinkingText: `Plan for ${prompt}`, tools,
      },
    ],
  } as unknown as DesktopChatSessionDetail;
}

function nativeSnapshot(sessionId: string, parentSessionId: string, title: string, status = 'done'): NativeAgentSubsession {
  return { sessionId, parentSessionId, parentRequestId: null, title, status, messages: [] };
}

/** This Mac's runtime: session details by id and the background sessions it holds. */
function nativeRuntime(details: DesktopChatSessionDetail[], snapshots: NativeAgentSubsession[]) {
  const detailCalls: string[] = [];
  const native: NonNullable<SubsessionTraceDeps['native']> = {
    listIds: () => Promise.resolve(snapshots.map((snapshot) => snapshot.sessionId)),
    snapshot: (id) => {
      const snapshot = snapshots.find((candidate) => candidate.sessionId === id);
      return snapshot ? Promise.resolve(snapshot) : Promise.reject(new Error('Subsession not found'));
    },
    fetchDetail: (id) => {
      detailCalls.push(id);
      const detail = details.find((candidate) => candidate.id === id);
      return detail ? Promise.resolve(detail) : Promise.reject(new Error('The subsession runtime profile is unavailable on this Mac'));
    },
  };
  return { native, detailCalls };
}

function deps(native: SubsessionTraceDeps['native'], cloud: SubsessionTraceDeps['cloud'] = null, runtime = native): CollectSessionTraceDeps {
  return {
    runtime: runtime ? { fetchDetail: runtime.fetchDetail } : null,
    canonical: { state: null, fetchPage: () => Promise.reject(new Error('unused')) },
    cloud: null,
    subsessions: { native, cloud },
    localAgentLabel: 'Kordi',
  };
}

async function exportLines(collectDeps: CollectSessionTraceDeps) {
  const trace = await collectSessionTrace(MAIN, collectDeps);
  const text = serializeSessionTrace({
    exportedAt: new Date(BASE_MS + 600_000),
    session: { id: MAIN, kind: 'self-agent', title: 'Counting', createdAtMs: BASE_MS },
    participants: [{ id: 'human:acct_alex', name: 'Alex', kind: 'human', role: 'self' }],
    exportedBy: ALEX,
    viewerIdentityId: 'human:acct_alex',
    messages: trace.messages,
    subsessions: trace.subsessions,
    complete: trace.complete,
  });
  assert.ok(text.endsWith('\n'));
  return { trace, text, lines: text.trimEnd().split('\n').map((line) => JSON.parse(line) as Line) };
}

function subsessionBlocks(lines: Line[]) {
  return lines.filter((line) => line.type === 'subsession');
}

function messagesOf(lines: Line[], sessionId: string) {
  return lines.filter((line) => line.type === 'message' && line.session_id === sessionId);
}

test('a referenced local background session follows the main session with its full tool data', async () => {
  const main = runtimeDetail(MAIN, 'Count in the background', 'Started a background count.', [spawnTool('call-spawn', 'bg-count', 'Count From One To Eight')]);
  const child = runtimeDetail('bg-count', 'Count from one to eight', '1 2 3 4 5 6 7 8', [{
    id: 'call-seq', name: 'bash', status: 'done', arguments: '{"command":"seq 1 8"}', liveOutput: '', resultText: '1\n2\n3\n4\n5\n6\n7\n8', isError: false,
  }], 5_000);
  const { native, detailCalls } = nativeRuntime([main, child], [nativeSnapshot('bg-count', MAIN, 'Count from one to eight')]);
  const { trace, lines } = await exportLines(deps(native));

  assert.equal(trace.complete, true);
  assert.deepEqual(detailCalls, [MAIN, 'bg-count']);
  const [header, ...rest] = lines;
  assert.equal(header.message_count, 2);
  assert.equal(header.subsession_count, 1);
  assert.equal(header.complete, true);
  assert.deepEqual(rest.map((line) => line.type), ['message', 'message', 'subsession', 'message', 'message']);
  assert.ok(rest.filter((line) => line.type === 'message').every((line) => Object.keys(line)[1] === 'session_id'));

  const mainAgent = messagesOf(lines, MAIN)[1];
  const [block] = subsessionBlocks(lines);
  assert.deepEqual(Object.keys(block), ['type', 'id', 'parent_session_id', 'parent_message_id', 'parent_tool_id', 'title', 'status', 'source', 'available', 'message_count']);
  assert.deepEqual(block, {
    type: 'subsession', id: 'bg-count', parent_session_id: MAIN, parent_message_id: mainAgent.id, parent_tool_id: 'call-spawn',
    title: 'Count from one to eight', status: 'done', source: 'local', available: true, message_count: 2,
  });
  const [childUser, childAgent] = messagesOf(lines, 'bg-count');
  assert.deepEqual([childUser.seq, childAgent.seq], [1, 2]);
  assert.equal(childUser.text, 'Count from one to eight');
  const turn = childAgent.agent_turn as Line;
  assert.equal(turn.model, 'claude-test');
  assert.equal(turn.thinking, 'Plan for Count from one to eight');
  assert.deepEqual(turn.tools, [{ id: 'call-seq', name: 'bash', status: 'done', arguments: '{"command":"seq 1 8"}', result: '1\n2\n3\n4\n5\n6\n7\n8', is_error: false }]);
});

test('nested background sessions are exported depth first and each session once', async () => {
  const main = runtimeDetail(MAIN, 'Plan the launch', 'Two tasks started.', [
    spawnTool('call-a', 'bg-a', 'Research venues'),
    spawnTool('call-b', 'bg-b', 'Draft invitations'),
    // The same task named again, and the main session itself, are never exported twice or looped into.
    spawnTool('call-a-again', 'bg-a', 'Research venues'),
    spawnTool('call-self', MAIN, 'Plan the launch'),
  ]);
  const a = runtimeDetail('bg-a', 'Research venues', 'Harbor Hall.', [spawnTool('call-a1', 'bg-a1', 'Check prices')]);
  const a1 = runtimeDetail('bg-a1', 'Check prices', 'Affordable.', [spawnTool('call-back', 'bg-a', 'Research venues')]);
  const b = runtimeDetail('bg-b', 'Draft invitations', 'Drafted.', [spawnTool('call-b-a', 'bg-a', 'Research venues')]);
  const { native, detailCalls } = nativeRuntime([main, a, a1, b], [
    nativeSnapshot('bg-a', MAIN, 'Research venues'), nativeSnapshot('bg-a1', 'bg-a', 'Check prices'), nativeSnapshot('bg-b', MAIN, 'Draft invitations'),
  ]);
  const { trace, lines } = await exportLines(deps(native));

  assert.equal(trace.complete, true);
  assert.deepEqual(detailCalls, [MAIN, 'bg-a', 'bg-a1', 'bg-b']);
  assert.deepEqual(subsessionBlocks(lines).map((block) => [block.id, block.parent_session_id, block.parent_tool_id]), [
    ['bg-a', MAIN, 'call-a'], ['bg-a1', 'bg-a', 'call-a1'], ['bg-b', MAIN, 'call-b'],
  ]);
  assert.equal(lines[0].subsession_count, 3);
  // Each block's messages follow its own line.
  const order = lines.slice(1).map((line) => `${line.type}:${String(line.type === 'subsession' ? line.id : line.session_id)}`);
  assert.deepEqual(order, [
    `message:${MAIN}`, `message:${MAIN}`, 'subsession:bg-a', 'message:bg-a', 'message:bg-a',
    'subsession:bg-a1', 'message:bg-a1', 'message:bg-a1', 'subsession:bg-b', 'message:bg-b', 'message:bg-b',
  ]);
});

test('an unreadable background session is written as unavailable and the export still succeeds', async () => {
  const main = runtimeDetail(MAIN, 'Ask around', 'Started.', [
    spawnTool('call-gone', 'bg-gone', 'Deleted task'),
    spawnTool('call-broken', 'bg-broken', 'Local task'),
  ]);
  const { native } = nativeRuntime([main], [nativeSnapshot('bg-broken', MAIN, 'Local task', 'stopped')]);
  const cloud: SubsessionTraceDeps['cloud'] = {
    accountId: ALEX,
    listTasks: () => Promise.reject(new Error('session_not_found')),
    read: () => Promise.reject(new Error('subsession_not_found')),
  };
  const { trace, lines } = await exportLines(deps(native, cloud));

  assert.equal(trace.complete, false);
  assert.equal(lines[0].complete, false);
  assert.equal(lines[0].subsession_count, 2);
  const [gone, broken] = subsessionBlocks(lines);
  assert.deepEqual(Object.keys(gone), ['type', 'id', 'parent_session_id', 'parent_message_id', 'parent_tool_id', 'title', 'source', 'available', 'message_count']);
  assert.deepEqual([gone.id, gone.source, gone.available, gone.message_count, gone.title], ['bg-gone', 'cloud', false, 0, 'Deleted task']);
  assert.deepEqual([broken.id, broken.source, broken.available, broken.message_count, broken.status], ['bg-broken', 'local', false, 0, 'stopped']);
  assert.equal(messagesOf(lines, 'bg-gone').length + messagesOf(lines, 'bg-broken').length, 0);
});

test('a failed read of the main session still fails the export', async () => {
  const { native } = nativeRuntime([], [nativeSnapshot('bg-count', MAIN, 'Count')]);
  await assert.rejects(collectSessionTrace(MAIN, deps(native)), /runtime profile is unavailable/);
});

function cloudRecord(sessionId: string, owner: string, extra: Partial<CloudAgentSubsession> = {}): CloudAgentSubsession {
  const agentId = `cloud-agent:${owner}`;
  return {
    sessionId, parentSessionId: MAIN, parentRequestId: `${MAIN}-entry-1`, title: 'Research Venue Options', status: 'done',
    ownerAccountId: owner, agentId, ownerDisplayName: owner === ALEX ? 'Alex' : 'Maya', agentDisplayName: owner === ALEX ? 'Alex\'s Kordi' : 'Maya\'s Kordi',
    version: 3, updatedAt: new Date(BASE_MS).toISOString(), live: false,
    messages: [
      { id: `${sessionId}-brief`, role: 'user', text: 'Find venues near the river', timestampMs: BASE_MS + 10_000, senderAgentId: agentId },
      {
        id: `${sessionId}-answer`, role: 'assistant', text: 'Harbor Hall is free.', timestampMs: BASE_MS + 20_000, requestState: 'completed',
        activity: { tools: [{ id: 'web-1', name: 'web_search', status: 'done', arguments: '{"q":"river venues"}', liveOutput: '', resultText: 'Harbor Hall listing', isError: false }] },
      },
    ],
    ...extra,
  };
}

test('cloud background sessions are read from the cloud record, linked ones included, with the visible trace only', async () => {
  // The web app has no runtime: the main session comes from this Mac fixture, background sessions from the cloud.
  const main = runtimeDetail(MAIN, 'Find a venue', 'Asked two agents.', [spawnTool('call-own', 'cloud-own', 'Research venue options')]);
  const { native: mainRuntime } = nativeRuntime([main], []);
  const records = new Map([
    ['cloud-own', cloudRecord('cloud-own', ALEX)],
    ['cloud-maya', cloudRecord('cloud-maya', MAYA, { title: 'Maya venue check' })],
  ]);
  const listed = (sessionId: string, parentSessionId: string): AgentSubsessionTask => ({
    sessionId, parentSessionId, parentRequestId: `${MAIN}-entry-1`, agentId: `cloud-agent:${MAYA}`, ownerAccountId: MAYA,
    ownerDisplayName: 'Maya', agentDisplayName: 'Maya\'s Kordi', title: 'Maya venue check', status: 'done',
    executionBackend: 'cloud', startedAtMs: null, finishedAtMs: null, heartbeatAtMs: 0, live: false, queued: false,
  });
  const reads: string[] = [];
  const cloud: SubsessionTraceDeps['cloud'] = {
    accountId: ALEX,
    listTasks: () => Promise.resolve({ sessions: [listed('cloud-own', MAIN), listed('cloud-maya', 'runtime-elsewhere')], nextCursor: null }),
    read: (sessionId) => {
      reads.push(sessionId);
      const record = records.get(sessionId);
      return record ? Promise.resolve(record) : Promise.reject(new Error('subsession_not_found'));
    },
  };
  const { trace, lines, text } = await exportLines(deps(null, cloud, mainRuntime));

  assert.equal(trace.complete, true);
  assert.deepEqual(reads, ['cloud-own', 'cloud-maya']);
  const [own, maya] = subsessionBlocks(lines);
  const mainUser = messagesOf(lines, MAIN)[0];
  assert.deepEqual([own.id, own.source, own.available, own.title, own.parent_tool_id], ['cloud-own', 'cloud', true, 'Research venue options', 'call-own']);
  // An Agent thread the server links to this chat under another parent still belongs to it.
  assert.deepEqual([maya.id, maya.parent_session_id, maya.parent_message_id, maya.message_count], ['cloud-maya', MAIN, mainUser.id, 2]);
  assert.equal('parent_tool_id' in maya, false);

  const ownAgent = messagesOf(lines, 'cloud-own')[1];
  assert.equal(ownAgent.text, 'Harbor Hall is free.');
  assert.deepEqual((ownAgent.agent_turn as Line).tools, [{ id: 'web-1', name: 'web_search', status: 'done', arguments: '{"q":"river venues"}', result: 'Harbor Hall listing', is_error: false }]);
  // Another member's agent shows its reply, never its tool calls.
  const mayaAgent = messagesOf(lines, 'cloud-maya')[1];
  assert.deepEqual((mayaAgent.agent_turn as Line).tools, []);
  assert.equal(text.split('Harbor Hall listing').length - 1, 1);
});

test('a local background session this Mac cannot resume falls back to its cloud record', async () => {
  const main = runtimeDetail(MAIN, 'Count', 'Started.', [spawnTool('call-spawn', 'bg-count', 'Count')]);
  const { native } = nativeRuntime([main], [nativeSnapshot('bg-count', MAIN, 'Count')]);
  const cloud: SubsessionTraceDeps['cloud'] = {
    accountId: ALEX,
    listTasks: () => Promise.resolve({ sessions: [], nextCursor: null }),
    read: () => Promise.resolve(cloudRecord('bg-count', ALEX, { title: 'Count' })),
  };
  const { trace, lines } = await exportLines(deps(native, cloud));
  assert.equal(trace.complete, true);
  const [block] = subsessionBlocks(lines);
  assert.deepEqual([block.source, block.available, block.message_count], ['cloud', true, 2]);
});

test('a background session this Mac links to the session is exported without a transcript reference', async () => {
  const main = runtimeDetail(MAIN, 'Count', 'Done.');
  const child = runtimeDetail('bg-linked', 'Count quietly', 'Counted.');
  const { native } = nativeRuntime([main, child], [nativeSnapshot('bg-linked', MAIN, 'Count quietly'), nativeSnapshot('bg-other', 'another-session', 'Other')]);
  const { lines } = await exportLines(deps(native));
  assert.deepEqual(subsessionBlocks(lines).map((block) => [block.id, block.source, block.message_count]), [['bg-linked', 'local', 2]]);
});

test('background sessions stop at the depth and total caps and mark the trace incomplete', async () => {
  const chain = Array.from({ length: MAX_SUBSESSION_DEPTH + 2 }, (_, index) => `bg-depth-${index + 1}`);
  const details = [MAIN, ...chain].map((id, index) => runtimeDetail(id, `Level ${index}`, 'Next.', chain[index] ? [spawnTool(`call-${index}`, chain[index], `Level ${index + 1}`)] : []));
  const deep = nativeRuntime(details, chain.map((id, index) => nativeSnapshot(id, index ? chain[index - 1] : MAIN, `Level ${index + 1}`)));
  const depthExport = await exportLines(deps(deep.native));
  assert.deepEqual(subsessionBlocks(depthExport.lines).map((block) => block.id), chain.slice(0, MAX_SUBSESSION_DEPTH));
  assert.equal(depthExport.trace.complete, false);
  assert.equal(deep.detailCalls.includes(chain[MAX_SUBSESSION_DEPTH]), false);

  const wide = (count: number) => {
    const ids = Array.from({ length: count }, (_, index) => `bg-wide-${index + 1}`);
    const main = runtimeDetail(MAIN, 'Fan out', 'Started.', ids.map((id, index) => spawnTool(`call-${index}`, id, `Task ${index + 1}`)));
    return nativeRuntime([main, ...ids.map((id) => runtimeDetail(id, id, 'Done.'))], ids.map((id) => nativeSnapshot(id, MAIN, id)));
  };
  const capped = await exportLines(deps(wide(MAX_SUBSESSIONS + 5).native));
  assert.equal(subsessionBlocks(capped.lines).length, MAX_SUBSESSIONS);
  assert.equal(capped.lines[0].subsession_count, MAX_SUBSESSIONS);
  assert.equal(capped.trace.complete, false);
  const full = await exportLines(deps(wide(MAX_SUBSESSIONS).native));
  assert.equal(subsessionBlocks(full.lines).length, MAX_SUBSESSIONS);
  assert.equal(full.trace.complete, true);
});
