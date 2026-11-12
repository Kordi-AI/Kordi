import { expect, test } from '@playwright/test';
import { account, installApiFixture, isCancelledFixtureRequest } from './apiFixture';

const CHANNELS = 32;
const MESSAGES_PER_CHANNEL = 1024;
const MEMBERS = 40;
const PIN_SEQUENCE = 21;
const stamp = (sequence: number) => new Date(Date.UTC(2026, 9, 20, 0, sequence)).toISOString();
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const text = (channel: number, sequence: number) => `Fixture channel ${channel} message ${sequence}.`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrZkAAAAASUVORK5CYII=', 'base64');

test('large group history pages, retries, and opens an old pin through the web app', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => {
    if (!isCancelledFixtureRequest(error.message)) errors.push(error.message);
  });
  await installApiFixture(page, baseURL!, true);
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    let messageWrites = 0;
    Object.defineProperty(window, 'fixtureCanonicalWrites', { get: () => messageWrites });
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'canonical-messages') messageWrites++;
      return original.call(this, value, key);
    };
  });
  const members = Array.from({ length: MEMBERS }, (_, index) => ({
    account_id: index ? `acct_fixture_member_${index}` : account.accountId,
    display_name: index ? `Fixture Member ${index}` : account.displayName,
    avatar_url: null, role: index ? 'member' : 'owner', membership_state: 'active',
    version: 1, last_delivered_sequence: 0, last_read_sequence: MESSAGES_PER_CHANNEL,
    joined_at: stamp(0), left_at: null,
  }));
  const conversations = Array.from({ length: CHANNELS }, (_, index) => ({
    id: uuid(index + 1), kind: 'group', shared_title: `Fixture Channel ${index + 1}`,
    group_title: `Fixture Channel ${index + 1}`, group_space_id: null, version: 1,
    created_by_account_id: account.accountId, legacy_session_id: `session:group:${uuid(index + 1)}`,
    latest_message_sequence: MESSAGES_PER_CHANNEL, created_at: stamp(0),
    updated_at: stamp(MESSAGES_PER_CHANNEL + index), members,
    preferences: { conversation_id: uuid(index + 1), account_id: account.accountId, personal_title: null, version: 1 },
  }));
  const message = (channel: number, sequence: number) => {
    const media = channel === 1 && sequence === MESSAGES_PER_CHANNEL - 1;
    return {
      id: uuid(1_000_000 + channel * 10_000 + sequence),
      client_message_id: uuid(2_000_000 + channel * 10_000 + sequence), conversation_id: uuid(channel),
      conversation_sequence: sequence, sender_account_id: members[1 + sequence % (MEMBERS - 1)].account_id,
      kind: 'text', content: { schema: 1, blocks: [{ type: 'text', text: text(channel, sequence) }],
        legacy_attachments: media ? [{
          attachmentId: 'fixture-thumbnail', kind: 'image', name: 'fixture.png', mimeType: 'image/png',
          sizeBytes: png.length, widthPixels: 320, heightPixels: 180,
        }] : [] },
      reply_to_message_id: null, attachment_ids: media ? ['fixture-thumbnail'] : [], version: 1,
      generation_status: null, provider_response_id: null, created_at: stamp(sequence), edited_at: null, deleted_at: null,
    };
  };
  const pinId = message(1, PIN_SEQUENCE).client_message_id;
  const pin = { sessionId: conversations[0].legacy_session_id, sharedMessageIds: [pinId],
    sharedMessageId: pinId, privateMessageId: null, effectiveMessageId: pinId, updatedAt: stamp(PIN_SEQUENCE) };
  const visibility = { hiddenSessionIds: [], deletedSessionIds: [], unreadSessionIds: [],
    pinnedSessionIds: [], mutedSessionIds: [], pinnedGroupSpaceIds: [] };
  const calls: Array<{ channel: number; before: number | null; around: string | null; limit: number }> = [];
  const mediaRequests: string[] = [];
  let bootstrapCount = 0;
  let failLatest = true;
  let failOlder = true;
  const anchorBefore = PIN_SEQUENCE - 7;
  let releasePinnedPage: () => void = () => {};
  const pinnedPageGate = new Promise<void>(resolve => { releasePinnedPage = resolve; });
  await page.route('**/v*/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseURL) return route.abort();
    const path = url.pathname;
    let body: unknown;
    if (path === '/v2/chat/sync/bootstrap') {
      bootstrapCount += 1;
      body = { protocol_version: 2, conversations,
        latest_messages: conversations.map((_, index) => message(index + 1, MESSAGES_PER_CHANNEL - Number(index === CHANNELS - 1))),
        session_visibility: visibility, session_pins: [pin], next_cursor: 'fixture-history-cursor', last_stream_seq: 1, server_time: stamp(0) };
    } else if (path === '/v2/chat/sync') {
      body = { protocol_version: 2, events: [], next_cursor: 'fixture-history-cursor', last_stream_seq: 1, has_more: false };
    } else if (path.endsWith('/pin')) body = { pin };
    else if (path.endsWith('/pin-history')) body = { events: [], hasMore: false, nextBefore: null };
    else if (/^\/v2\/chat\/conversations\/[^/]+\/messages$/.test(path) && request.method() === 'GET') {
      const channel = conversations.findIndex(row => row.id === path.split('/')[4]) + 1;
      if (!channel) return route.fallback();
      const limit = Number(url.searchParams.get('limit'));
      const before = url.searchParams.has('before_sequence') ? Number(url.searchParams.get('before_sequence')) : null;
      const around = url.searchParams.get('around_message_id');
      calls.push({ channel, before, around, limit });
      await new Promise(resolve => setTimeout(resolve, 75));
      if (channel === 1 && before === anchorBefore) await pinnedPageGate;
      if (channel === 1 && !around && (before === null ? failLatest : failOlder)) {
        if (before === null) failLatest = false;
        else failOlder = false;
        return route.fulfill({ status: 503, json: { error: { code: 'fixture_timeout', message: 'Synthetic history timeout.' } } });
      }
      const highest = around === pinId ? PIN_SEQUENCE + Math.floor((limit - 1) / 2) : (before ?? MESSAGES_PER_CHANNEL + 1) - 1;
      const end = Math.max(1, highest - limit + 1);
      body = { messages: Array.from({ length: highest - end + 1 }, (_, offset) => message(channel, highest - offset)),
        next_before_sequence: end > 1 ? end : null, has_more: end > 1,
        ...(around === pinId ? { anchor_message_id: message(channel, PIN_SEQUENCE).id } : {}) };
    } else if (path.startsWith('/v1/cloud/attachments/fixture-thumbnail/')) {
      mediaRequests.push(path.split('/').at(-1)!);
      return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    } else if (path.startsWith('/v1/cloud/auth/profiles/') || /^\/v1\/cloud\/accounts\/[^/]+\/profile$/.test(path)) {
      const accountId = decodeURIComponent(path.split('/').at(path.endsWith('/profile') ? -2 : -1)!);
      body = { accountId, displayName: members.find(member => member.account_id === accountId)?.display_name ?? 'Fixture Member', avatarUrl: null, avatar: null, defaultAgent: null };
    } else if (/^\/v2\/chat\/conversations\/[^/]+\/(read|delivered)$/.test(path)) body = {};
    else if (path === '/v2/chat/attention') body = [];
    else if (path.startsWith('/v1/cloud/presence')) body = { presence: [] };
    else if (path === '/v2/calls/active') body = { calls: [] };
    else return route.fallback();
    return route.fulfill({ status: 200, json: body });
  });

  await page.goto(`/app/chats/${encodeURIComponent(conversations[0].legacy_session_id)}`);
  const transcript = page.getByRole('region', { name: 'Conversation messages' });
  const retry = page.getByRole('button', { name: 'Retry history' });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(transcript.getByText(text(1, MESSAGES_PER_CHANNEL - 7), { exact: true })).toBeVisible();
  await expect(transcript.getByAltText('fixture.png')).toBeVisible();
  await expect.poll(() => mediaRequests).toEqual(['preview-content']);

  const scroller = page.locator('.app-chat-pane-transcript-scroll').first();
  await scroller.evaluate(element => { element.scrollTop = 0; });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => calls.filter(call => call.channel === 1 && call.before === 975).length).toBe(2);
  await expect(retry).toBeHidden();

  const pinned = page.locator('[data-pinned-message-bar]');
  await expect(pinned).toContainText(text(1, PIN_SEQUENCE));
  await page.getByRole('button', { name: 'View all 1 pinned messages' }).click();
  const list = page.getByRole('dialog', { name: 'Pinned messages' });
  await expect(list).toContainText(text(1, PIN_SEQUENCE));
  await list.getByRole('button', { name: new RegExp(text(1, PIN_SEQUENCE)) }).first().click();
  await expect(transcript.getByText(text(1, PIN_SEQUENCE), { exact: true })).toBeVisible();
  await expect(transcript.getByText(text(1, MESSAGES_PER_CHANNEL), { exact: true })).toHaveCount(0);
  try {
    await scroller.evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })));
    await expect.poll(() => calls.some(call => call.before === anchorBefore)).toBe(true);
    await page.getByRole('button', { name: 'Back to latest messages' }).click();
    const response = page.waitForResponse(url => new URL(url.url()).searchParams.get('before_sequence') === String(anchorBefore));
    releasePinnedPage();
    await response;
  } finally {
    releasePinnedPage();
  }
  await expect(transcript.getByText(text(1, MESSAGES_PER_CHANNEL), { exact: true })).toBeVisible();


  await page.getByTestId('participant-space-row').filter({ hasText: text(2, MESSAGES_PER_CHANNEL) }).click({ timeout: 5_000 });
  await expect(transcript.getByText(text(2, MESSAGES_PER_CHANNEL - 7), { exact: true })).toBeVisible();
  expect(calls.filter(call => call.channel > 2)).toEqual([]);
  expect(calls.filter(call => call.around === pinId).map(call => call.limit)).toEqual([1, 15]);
  expect(calls.every(call => call.limit <= 50)).toBe(true);
  expect(calls.length).toBeLessThanOrEqual(9);
  const messageWrites = await page.evaluate(() => (window as Window & { fixtureCanonicalWrites?: number }).fixtureCanonicalWrites);
  expect(messageWrites).toBeLessThan(300);
  expect(bootstrapCount).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});
