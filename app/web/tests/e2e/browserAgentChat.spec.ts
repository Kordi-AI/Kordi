import { expect, test } from '@playwright/test';
import { account, isCancelledFixtureRequest } from './apiFixture';
import { installChatFixture } from './chatFixture';

const sessionId = 'session:self-agent:synthetic-browser-agent-send';
const desktopRequired = 'This feature requires the Kordi desktop app';
const replyText = 'Synthetic hosted reply.';

function envelopeText(text: string) {
  const prefix = 'kordi-cloud-message:';
  if (!text.startsWith(prefix)) return text;
  return (JSON.parse(Buffer.from(text.slice(prefix.length), 'base64url').toString()) as { text?: string }).text ?? '';
}

test('the owner agent chat sends from the browser and renders the hosted reply', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  const fixture = await installChatFixture(page, baseURL!);
  await page.route('**/v1/cloud/agent-provider-auth/snapshots?*', route => route.fulfill({ json: { snapshots: [{
    snapshotId: 'synthetic-agent-provider', provider: 'openai', authChoice: 'api-key', label: 'Synthetic provider',
    modelHint: 'gpt-4.1', createdAt: '2026-11-05T12:00:00Z', revokedAt: null,
  }] } }));
  fixture.conversation.kind = 'ai';
  fixture.conversation.legacy_session_id = sessionId;
  fixture.conversation.members = [fixture.conversation.members[0]];
  fixture.messages[0].sender_account_id = account.accountId;
  fixture.messages[0].content.blocks[0].text = 'Earlier agent request.';
  // The hosted run answers the stored request; the reply reaches the browser through chat sync.
  const events: Record<string, unknown>[] = [];
  await page.route('**/v2/chat/sync?*', route => {
    const request = fixture.messages.find(row => envelopeText(row.content.blocks[0]?.text ?? '') === 'Plan the browser launch.');
    if (request && events.length === 0) {
      const response = { kind: 'agent-response', requestId: request.id, text: replyText, deliveryState: 'complete' };
      const reply = { ...request, id: 'browser-agent-reply', client_message_id: 'client-browser-agent-reply',
        conversation_sequence: fixture.messages.length + 1, reply_to_message_id: request.id,
        content: { schema: 1, blocks: [{ type: 'text', text: `kordi-cloud-agent-response:${Buffer.from(JSON.stringify(response)).toString('base64url')}` }], legacy_attachments: [] } };
      fixture.messages.push(reply);
      fixture.conversation.latest_message_sequence = fixture.messages.length;
      events.push({ type: 'message.created', payload: { message: reply }, stream_seq: 100, event_id: 'browser-agent-reply-event',
        protocol_version: 2, critical: true, conversation_id: fixture.conversation.id, entity_id: reply.id,
        entity_version: 1, occurred_at: '2026-11-05T12:01:00Z' });
    }
    const delivered = new URL(route.request().url()).searchParams.get('cursor') === 'agent-reply';
    return route.fulfill({ json: { protocol_version: 2, events: delivered ? [] : events,
      next_cursor: events.length ? 'agent-reply' : 'chat-1', last_stream_seq: events.length ? 100 : 1,
      has_more: false, server_time: '2026-11-05T12:01:00Z' } });
  });

  await page.goto(`/app/agent-chats/${encodeURIComponent(sessionId)}`);
  const composer = page.getByRole('textbox', { name: /Ask your agent/ });
  await expect(composer).toBeVisible();
  await expect(page.getByText('Earlier agent request.', { exact: true }).last()).toBeVisible();
  await composer.fill('Plan the browser launch.');
  await composer.press('Enter');

  // The first send also stores the agent identity row; the request is the text message.
  const requests = () => (fixture.sent as { kind: string; content: { blocks: { text: string }[] } }[])
    .filter(row => row.kind === 'text').map(row => envelopeText(row.content.blocks[0].text));
  await expect.poll(requests).toEqual(['Plan the browser launch.']);
  await expect(page.getByText('Plan the browser launch.', { exact: true }).last()).toBeVisible();
  await expect(composer).toHaveText('');
  await expect(page.getByText(replyText, { exact: true }).last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(desktopRequired)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a failed owner agent request retries from the browser', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  const fixture = await installChatFixture(page, baseURL!);
  await page.route('**/v1/cloud/agent-provider-auth/snapshots?*', route => route.fulfill({ json: { snapshots: [{
    snapshotId: 'synthetic-agent-provider', provider: 'openai', authChoice: 'api-key', label: 'Synthetic provider',
    modelHint: 'gpt-4.1', createdAt: '2026-11-05T12:00:00Z', revokedAt: null,
  }] } }));
  fixture.conversation.kind = 'ai';
  fixture.conversation.legacy_session_id = sessionId;
  fixture.conversation.members = [fixture.conversation.members[0]];
  fixture.messages[0].sender_account_id = account.accountId;
  fixture.messages[0].content.blocks[0].text = 'Earlier agent request.';
  // A request that failed earlier in this browser is stored locally with its failure.
  await page.route('**/fixture-canonical-seed', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Synthetic cache fixture</title>',
  }));
  await page.goto('/fixture-canonical-seed');
  await page.evaluate(async ({ scope, accountId, displayName, sessionId }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('kordi-browser-canonical-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('projections');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('projections', 'readwrite');
        const humanIdentityId = `human:${accountId}`;
        const now = Date.UTC(2026, 10, 5, 11);
        transaction.objectStore('projections').put({
          storagePath: '',
          profile: { id: `web:${accountId}`, humanIdentityId, storageRoot: '', createdAtMs: now, updatedAtMs: now },
          identities: [{ id: humanIdentityId, kind: 'human', source: 'cloud', humanId: accountId, displayName, createdAtMs: now, updatedAtMs: now }],
          sessions: [{ id: sessionId, kind: 'self-agent', status: 'active', title: 'Failed request',
            createdAtMs: now, updatedAtMs: now, createdByIdentityId: humanIdentityId }],
          participants: [{ sessionId, identityId: humanIdentityId, role: 'self', state: 'active', addedAtMs: now }],
          delegatedExchanges: [], presence: [], contextSnapshots: [],
          messages: [{ id: 'fixture-failed-request', sessionId, senderIdentityId: humanIdentityId, senderRole: 'user',
            messageKind: 'text', status: 'failed', sequenceNum: 1, contentText: 'Retry this request.',
            content: { deliveryState: 'failed', detail: 'Synthetic failure.' }, createdAtMs: now, updatedAtMs: now }],
        }, scope);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, { scope: JSON.stringify([account.accountId, 'browser-test-org']), accountId: account.accountId, displayName: account.displayName, sessionId });

  await page.goto(`/app/agent-chats/${encodeURIComponent(sessionId)}`);
  const retry = page.getByRole('button', { name: 'Retry sending message', exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  const requests = () => (fixture.sent as { kind: string; content: { blocks: { text: string }[] } }[])
    .filter(row => row.kind === 'text').map(row => envelopeText(row.content.blocks[0].text));
  await expect.poll(requests).toEqual(['Retry this request.']);
  await expect(retry).toHaveCount(0);
  await expect(page.getByText(desktopRequired)).toHaveCount(0);
  expect(errors).toEqual([]);
});
