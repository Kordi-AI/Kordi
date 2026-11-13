import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResultsScreen } from '../src/features/commonGround/ResultsScreen';
import { CommonGroundStore } from '../src/features/commonGround/store';
import type { CgHost } from '../src/features/commonGround/host';
import type { CgGroup } from '../src/features/commonGround/types';
import { groupJoinRequestFromChatContent, normalizeGroupJoinRequestCard } from '../src/features/cloud/groupJoinRequest';
import { GroupJoinRequestCardContent } from '../src/kordi-app/components/groupJoinRequestCard';
import { commonGroundFixtures } from './visual/commonGroundFixtures';
import { mockServer, person, room } from './helpers/commonGroundServer';

const fx = commonGroundFixtures('light');
const host: CgHost = {
  self: fx.self, profiles: true, memoryAvailable: false, connectors: null, agentFiles: null, device: null,
  openChat: () => undefined, acceptRequest: async () => undefined, contactsChanged: () => undefined,
  openGroup: () => undefined, openUrl: () => undefined,
};
const group = (patch: Partial<CgGroup>): CgGroup => ({
  groupSpaceId: 'session:group:1', conversationId: 'conv_1', name: 'Developer tools and CI', memberCount: 2,
  members: [person('acct_alex'), person('acct_bea')], joined: false, canAskToJoin: false, joinRequest: null, requests: [], ...patch,
});

async function render(groups: CgGroup[], routes: Parameters<typeof mockServer>[0] = {}) {
  const server = mockServer({ 'POST rooms/4821/results': { status: 200, body: { ...fx.results, groups } }, ...routes });
  const store = new CommonGroundStore(server.client, { profiles: true });
  store.set({ rooms: { '4821': room('4821') } });
  await store.loadScreen({ name: 'results', code: '4821' });
  const markup = () => renderToStaticMarkup(createElement(ResultsScreen, { code: '4821', state: store.getSnapshot(), store, host }));
  return { server, store, markup };
}

test('a room member outside a group can ask to join, then sees Requested with Cancel', async () => {
  const asked = await render([group({ canAskToJoin: true })]);
  assert.match(asked.markup(), />Ask to join</);

  const pending = await render([group({ joinRequest: { requestId: 'req_1', status: 'pending' } })]);
  const markup = pending.markup();
  assert.match(markup, />Requested</);
  assert.match(markup, />Cancel</);
  assert.doesNotMatch(markup, /Ask to join/);
});

test('a declined request or an older server leaves the group row view-only', async () => {
  for (const patch of [{ joinRequest: { requestId: 'req_1', status: 'declined' as const } }, { canAskToJoin: undefined, requests: undefined, joinRequest: undefined }]) {
    const { markup } = await render([group(patch)]);
    assert.doesNotMatch(markup(), /Ask to join|Requested|Approve/);
  }
});

test('approvers see pending requests under the group with Decline and Approve', async () => {
  const { markup } = await render([group({ joined: true, requests: [{ requestId: 'req_1', person: { ...person('acct_chen'), name: 'Chen Li' }, createdAt: '2026-11-13T10:00:00Z' }] })]);
  const html = markup();
  assert.match(html, />Open</);
  assert.match(html, /Chen Li asked to join/);
  assert.match(html, />Decline</);
  assert.match(html, />Approve</);
});

test('asking, cancelling and deciding call the join request routes and refresh the room', async () => {
  const { server, store } = await render([group({ canAskToJoin: true })], {
    'POST rooms/4821/join-requests': { status: 201, body: { request: { requestId: 'req_1', status: 'pending' } } },
    'DELETE rooms/4821/join-requests/req_1': { status: 200, body: { request: { requestId: 'req_1', status: 'cancelled' } } },
    'POST join-requests/req_2': { status: 200, body: { request: { requestId: 'req_2', status: 'approved' } } },
  });
  assert.equal(await store.askToJoin('4821', 'session:group:1'), true);
  assert.equal(await store.cancelJoinRequest('4821', 'req_1'), true);
  assert.equal(await store.decideJoinRequest('4821', 'req_2', 'approve'), true);
  const sent = server.calls.filter((call) => call.url.includes('join-requests'));
  assert.deepEqual(sent.map((call) => [call.method, call.body]), [
    ['POST', { groupSpaceId: 'session:group:1' }],
    ['DELETE', undefined],
    ['POST', { action: 'approve' }],
  ]);
  // Each action reloads the room's results.
  assert.equal(server.calls.filter((call) => call.url.endsWith('rooms/4821/results')).length, 4);
});

test('a refused request shows the server message', async () => {
  const { store } = await render([group({ canAskToJoin: true })], {
    'POST rooms/4821/join-requests': { status: 409, body: { errorCode: 'common_ground_room_closed', message: 'This room has closed.' } },
  });
  assert.equal(await store.askToJoin('4821', 'session:group:1'), false);
  assert.equal(store.getSnapshot().notice, 'This room has closed.');
});

const block = {
  type: 'group_join_request', requestId: 'req_1', groupSpaceId: 'session:group:1', conversationId: 'conv_1',
  groupName: 'Developer tools and CI', roomName: 'Build night',
  requester: { accountId: 'acct_chen', name: 'Chen Li', avatarUrl: null },
  status: 'pending', approverIds: ['acct_alex'], decidedBy: null, revision: 1,
};

test('the join request card is read from a System message and shows its state', () => {
  const card = groupJoinRequestFromChatContent({ schema: 1, blocks: [{ type: 'text', text: 'Chen Li asked to join.' }, block] });
  assert.ok(card);
  assert.equal(card.requester.name, 'Chen Li');
  assert.equal(groupJoinRequestFromChatContent({ blocks: [{ type: 'text', text: 'hi' }] }), null);
  assert.equal(normalizeGroupJoinRequestCard({ ...block, status: 'unknown' }), null);

  const pending = renderToStaticMarkup(createElement(GroupJoinRequestCardContent, { snapshot: card }));
  assert.match(pending, /Chen Li asked to join/);
  assert.match(pending, /From Build night/);
  // Signed out in tests, so this viewer is not an approver.
  assert.match(pending, /Waiting for approval/);
  assert.doesNotMatch(pending, />Approve</);

  const approved = normalizeGroupJoinRequestCard({ ...block, status: 'approved', decidedBy: { accountId: 'acct_alex', name: 'Alex Rivera' }, revision: 2 });
  assert.ok(approved);
  assert.match(renderToStaticMarkup(createElement(GroupJoinRequestCardContent, { snapshot: approved })), /Approved by Alex/);
  const cancelled = normalizeGroupJoinRequestCard({ ...block, status: 'cancelled', revision: 2 });
  assert.ok(cancelled);
  assert.match(renderToStaticMarkup(createElement(GroupJoinRequestCardContent, { snapshot: cancelled })), /Withdrawn/);
});
