import { expect, test, type Page } from '@playwright/test';
import { account, isCancelledFixtureRequest } from './apiFixture';
import { installChatFixture } from './chatFixture';

const timestamp = '2026-11-05T12:00:00Z';
const desktopRequired = /This feature requires the Kordi desktop app/;
const identityKind = 'canonical-history-agent-identity';
const existingTitle = 'Synthetic existing agent chat';

type Envelope = { text: string; targetCloudAgentId: string; agentRuntimeRoute: { model: string } };
type PostedMessage = { conversationId: string; envelope: Envelope };

async function installAgentChatFixture(page: Page, baseURL: string, hold: { release: (() => void) | null; pending: boolean }) {
  const fixture = await installChatFixture(page, baseURL);
  await page.route('**/v1/cloud/agent-provider-auth/snapshots?*', route => route.fulfill({ json: { snapshots: [{
    snapshotId: 'synthetic-agent-provider', provider: 'openai', authChoice: 'api-key', label: 'Synthetic provider',
    modelHint: 'gpt-4.1', createdAt: timestamp, revokedAt: null,
  }] } }));
  const base = fixture.conversation;
  const selfMember = base.members[0];
  const agentConversation = (id: string, title: string | null, sessionId: string) => ({ ...base, id, kind: 'ai',
    legacy_session_id: sessionId, members: [selfMember], shared_title: title,
    preferences: { ...base.preferences, conversation_id: id, personal_title: title } });
  const conversations = [agentConversation('agent-conv-existing', existingTitle, 'session:self-agent:synthetic-existing')];
  const messages = [{ ...fixture.messages[0], id: 'agent-seed-message', client_message_id: 'client-agent-seed-message',
    conversation_id: 'agent-conv-existing', sender_account_id: account.accountId }];
  const visibility = { hiddenSessionIds: [], deletedSessionIds: [], unreadSessionIds: [],
    pinnedSessionIds: [], mutedSessionIds: [], pinnedGroupSpaceIds: [] };
  await page.route('**/v2/chat/sync/bootstrap', route => route.fulfill({ json: { protocol_version: 2, conversations,
    latest_messages: messages, session_visibility: visibility, next_cursor: 'agent-fixture', last_stream_seq: 1, server_time: timestamp } }));
  await page.route('**/v2/chat/conversations', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const input = route.request().postDataJSON() as { client_session_id: string };
    const created = agentConversation(`agent-conv-created-${conversations.length}`, null, input.client_session_id);
    conversations.push(created);
    return route.fulfill({ json: { conversation: created } });
  });
  const posted: PostedMessage[] = [];
  await page.route('**/v2/chat/conversations/*/messages*', async route => {
    const conversationId = new URL(route.request().url()).pathname.split('/')[4];
    if (route.request().method() !== 'POST') {
      return route.fulfill({ json: { messages: messages.filter(row => row.conversation_id === conversationId), next_before_sequence: null, has_more: false } });
    }
    const input = route.request().postDataJSON() as { client_message_id: string; kind?: string; content: { blocks: { text: string }[] } };
    const text = input.content.blocks[0]?.text ?? '';
    const prefix = 'kordi-cloud-message:';
    expect(text.startsWith(prefix)).toBe(true);
    const envelope = JSON.parse(Buffer.from(text.slice(prefix.length), 'base64').toString('utf8')) as Envelope;
    // The identity-sync envelope is protocol bookkeeping, not a user send.
    const userSend = input.kind !== identityKind;
    if (userSend) posted.push({ conversationId, envelope });
    // Keep the first user request pending until the test releases it so the next send is queued behind it.
    if (userSend && hold.pending && !hold.release) await new Promise<void>(resolve => { hold.release = resolve; });
    const row = { ...fixture.messages[0], id: `posted-${messages.length}`, client_message_id: input.client_message_id,
      conversation_id: conversationId, conversation_sequence: messages.filter(item => item.conversation_id === conversationId).length + 1,
      sender_account_id: account.accountId, kind: input.kind ?? 'text', content: input.content };
    messages.push(row as typeof messages[number]);
    return route.fulfill({ json: { message: row } });
  });
  await page.route('**/v2/chat/conversations/*/{read,delivered}', route => route.fulfill({ json: {} }));
  return { fixture, posted };
}

const transcript = (page: Page) => page.locator('.app-chat-main-workspace');

async function sendFromComposer(page: Page, text: string) {
  const composer = page.getByRole('textbox', { name: /Ask your agent/ }).first();
  await composer.fill(text);
  await composer.press('Enter');
}

test('Agent Chat sends through the hosted message endpoint in an existing and a new chat without desktop-only errors', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  const hold = { release: null as (() => void) | null, pending: true };
  const { fixture, posted } = await installAgentChatFixture(page, baseURL!, hold);

  await page.goto('/app/agent-chats');
  const existingRow = page.locator('.app-sidebar-list-content').getByText(existingTitle, { exact: true }).first();
  await expect(existingRow).toBeVisible();
  await existingRow.click();

  const first = 'Synthetic first agent message';
  await sendFromComposer(page, first);
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0].conversationId).toBe('agent-conv-existing');
  expect(posted[0].envelope.text).toBe(first);
  expect(posted[0].envelope.targetCloudAgentId).toBe(`cloud-agent:${account.accountId}`);
  expect(posted[0].envelope.agentRuntimeRoute.model.length).toBeGreaterThan(0);
  await expect(transcript(page).getByText(first, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(desktopRequired)).toHaveCount(0);

  const second = 'Synthetic second agent message';
  await sendFromComposer(page, second);
  await expect(transcript(page).getByText(second, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Queued', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(desktopRequired)).toHaveCount(0);

  // The queued message waits for the running turn, so it is not posted yet.
  expect(posted).toHaveLength(1);
  hold.pending = false;
  hold.release?.();

  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.locator('.app-chat-create-list-item').first().click();
  const created = 'Synthetic new chat message';
  await sendFromComposer(page, created);
  // Matched by text: the queued message may also be posted once the held request is released.
  await expect.poll(() => posted.some(message => message.envelope.text === created)).toBe(true);
  const createdPost = posted.find(message => message.envelope.text === created)!;
  expect(createdPost.conversationId).toMatch(/^agent-conv-created-/);
  expect(createdPost.envelope.targetCloudAgentId).toBe(`cloud-agent:${account.accountId}`);
  expect(createdPost.envelope.agentRuntimeRoute.model.length).toBeGreaterThan(0);
  await expect(transcript(page).getByText(created, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(desktopRequired)).toHaveCount(0);

  expect(errors).toEqual([]);
  expect(await page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
  expect(fixture.requests.every(request => !request.headers.authorization)).toBe(true);
});
