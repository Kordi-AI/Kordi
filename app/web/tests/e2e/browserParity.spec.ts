import { expect, test, type Page } from '@playwright/test';
import { account } from './apiFixture';
import { chatConversationId, installChatFixture, peerName } from './chatFixture';

async function installHostedAccount(page: Page) {
  await page.route('**/v1/cloud/agent-provider-auth/snapshots?*', route => route.fulfill({ json: { snapshots: [{
    snapshotId: 'synthetic-agent-provider', provider: 'openai', authChoice: 'api-key', label: 'Synthetic provider',
    modelHint: 'gpt-4.1', createdAt: '2026-11-05T12:00:00Z', revokedAt: null,
  }] } }));
}

test('Contacts retains the desktop search and opens the selected contact detail', async ({ page, baseURL }) => {
  await installChatFixture(page, baseURL!);
  await page.goto('/app/contacts');
  const search = page.getByPlaceholder('Search contacts', { exact: true });
  await search.fill('No matching contact');
  await expect(page.getByText(peerName, { exact: true })).toHaveCount(0);
  await search.fill(peerName);
  await expect(page.getByText(peerName, { exact: true }).first()).toBeVisible();
  await page.getByText(peerName, { exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Message', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Message', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/chats\//);
  await expect(page.getByText('The browser conversation is ready.', { exact: true }).last()).toBeVisible();
});

test('Digest retains desktop views and imports ICS through the hosted app asset base', async ({ page, baseURL }) => {
  await installChatFixture(page, baseURL!);
  const events: Record<string, unknown>[] = [];
  const parserPaths: string[] = [];
  page.on('request', request => {
    if (/\/(ical|import)\.js$/.test(request.url())) parserPaths.push(new URL(request.url()).pathname);
  });
  await page.route('**/v1/cloud/digest?*', route => route.fulfill({ json: {
    accountId: account.accountId, status: 'ready', revision: 1, updatedAt: '2026-11-05T12:00:00Z',
    partial: false, feedback: [], sources: [],
    snapshot: { claims: [], commitments: [], suggestions: [], calendarCandidates: [] },
  } }));
  await page.route('**/v1/cloud/calendar/events**', route => {
    if (route.request().method() === 'PUT') {
      const event = route.request().postDataJSON() as Record<string, unknown>;
      events.push({ ...event, revision: 1 });
      return route.fulfill({ json: events[events.length - 1] });
    }
    return route.fulfill({ json: { events } });
  });
  await page.goto('/app/digest');
  for (const name of ['Brief', 'Next steps', 'Calendar']) {
    await expect(page.getByRole('button', { name, exact: true }).first()).toBeVisible();
  }
  await page.getByRole('button', { name: 'Enable calendar reminders', exact: true }).click();
  await expect(page.getByText('Calendar reminders require the desktop app. Imported events remain available here.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Import ICS', exact: true }).click();
  await page.getByRole('textbox', { name: 'Paste calendar text' }).fill([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:synthetic-parity-event',
    'DTSTART:20261106T120000Z', 'DTEND:20261106T123000Z', 'SUMMARY:Browser parity review',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n'));
  await page.getByLabel('From', { exact: true }).fill('2026-11-01');
  await page.getByLabel('Before', { exact: true }).fill('2026-12-01');
  await page.getByRole('button', { name: 'Preview events', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Review import', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Browser parity review/ })).toBeChecked();
  expect(parserPaths.sort()).toEqual(['/app/digest/ical.js', '/app/digest/import.js']);
  await page.getByRole('button', { name: 'Import selected', exact: true }).click();
  await expect(page.getByText('1 event imported.', { exact: true })).toBeVisible();
  expect(events).toHaveLength(1);
  expect(events[0].title).toBe('Browser parity review');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Calendar', exact: true }).first().click();
  await expect(page.getByRole('button', { name: /Browser parity review/ }).first()).toBeVisible();
});

test('Agent Chat header renames its hosted session and retains the title after refresh', async ({ page, baseURL }) => {
  const fixture = await installChatFixture(page, baseURL!);
  await installHostedAccount(page);
  const sessionId = 'session:self-agent:synthetic-browser-parity';
  fixture.conversation.kind = 'ai';
  fixture.conversation.legacy_session_id = sessionId;
  fixture.conversation.members = [fixture.conversation.members[0]];
  fixture.messages[0].sender_account_id = account.accountId;
  let title = 'Planning session';
  let writes = 0;
  await page.route(`**/v2/chat/conversations/${fixture.conversation.id}/preferences`, route => {
    title = (route.request().postDataJSON() as { personal_title: string }).personal_title;
    writes += 1;
    return route.fulfill({ json: { preferences: {
      ...fixture.conversation.preferences, personal_title: title, version: writes + 1,
    } } });
  });
  await page.route('**/v2/chat/sync/bootstrap', route => route.fulfill({ json: {
    protocol_version: 2,
    conversations: [{ ...fixture.conversation, shared_title: title,
      preferences: { ...fixture.conversation.preferences, personal_title: title, version: writes + 1 } }],
    latest_messages: fixture.messages,
    session_visibility: { hiddenSessionIds: [], deletedSessionIds: [], unreadSessionIds: [], pinnedSessionIds: [], mutedSessionIds: [], pinnedGroupSpaceIds: [] },
    next_cursor: 'agent-fixture', last_stream_seq: 1, server_time: '2026-11-05T12:00:00Z',
  } }));
  await page.goto(`/app/agent-chats/${encodeURIComponent(sessionId)}`);
  const rename = page.getByRole('button', { name: `Rename session ${title}`, exact: true });
  await expect(rename).toBeVisible();
  await rename.dblclick();
  await page.getByPlaceholder('Session name', { exact: true }).fill('Renamed hosted plan');
  await page.getByPlaceholder('Session name', { exact: true }).press('Enter');
  await expect.poll(() => writes).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Rename session Renamed hosted plan', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Rename session Renamed hosted plan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.locator('.app-chat-create-list-item').filter({ hasText: 'My agent' }).first().click();
  await expect(page).toHaveURL(/\/app\/agent-chats\/session%3Aagent%3A/);
  await expect(page.getByRole('button', { name: 'Rename session New chat', exact: true })).toBeVisible();
  await expect(page.getByText('The browser conversation is ready.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /Ask your agent/ })).toBeVisible();
});

test('the shared companion Chat action opens a separate browser Agent composer', async ({ page, baseURL }) => {
  await installChatFixture(page, baseURL!);
  await installHostedAccount(page);
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await expect(page.getByText('The browser conversation is ready.', { exact: true }).last()).toBeVisible();
  const controls = page.getByRole('group', { name: 'Companion panel', exact: true });
  await controls.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(controls.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: /Send your message|Ask the agent/ })).toHaveCount(2);
});

/** An Agent Chat with no stored route and only this hosted account; returns the model and effort controls. */
async function openRoutelessAgentChat(page: Page, baseURL: string, snapshot: { provider: string; authChoice: string; modelHint: string | null }) {
  const fixture = await installChatFixture(page, baseURL);
  await page.route('**/v1/cloud/agent-provider-auth/snapshots?*', route => route.fulfill({ json: { snapshots: [{
    snapshotId: `synthetic-${snapshot.provider}`, label: 'Work', createdAt: '2026-11-05T12:00:00Z', revokedAt: null, ...snapshot,
  }] } }));
  const sessionId = `session:self-agent:synthetic-${snapshot.provider}-default`;
  fixture.conversation.kind = 'ai';
  fixture.conversation.legacy_session_id = sessionId;
  fixture.conversation.members = [fixture.conversation.members[0]];
  fixture.messages[0].sender_account_id = account.accountId;
  await page.goto(`/app/agent-chats/${encodeURIComponent(sessionId)}`);
  return {
    model: page.getByRole('button', { name: /^Select model, current / }),
    effort: page.getByRole('button', { name: /^Adjust effort, current / }),
    menu: page.getByRole('dialog', { name: 'Select model' }),
  };
}

const rowNamed = (name: string) => new RegExp(`^${name.replace(/\./g, '\\.')}`);

test('a hosted Agent Chat with no stored route shows the ChatGPT default and offers only the ChatGPT models Kordi lists', async ({ page, baseURL }) => {
  // The account stores GPT-5.4, which Kordi no longer offers: it opens with the default.
  const { model, effort, menu } = await openRoutelessAgentChat(page, baseURL!, { provider: 'openai-codex', authChoice: 'cloud-login:synthetic', modelHint: 'gpt-5.4' });
  await expect(model).toHaveAccessibleName('Select model, current GPT-6.2 Sol');
  await expect(effort).toHaveAccessibleName('Adjust effort, current Default');
  await model.click();
  await expect(menu.getByRole('button', { name: /^Default/ })).toContainText('GPT-6.2 Sol');
  await menu.getByRole('button', { name: /^More models/ }).click();
  const offered = ['GPT-6.2 Sol', 'GPT-6.2 Astra', 'GPT-6.1 Terra', 'GPT-6.1 Sol', 'GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna',
    'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna'];
  await expect(menu.locator('.app-model-picker-list .app-model-picker-row'))
    .toHaveText(offered.map(name => new RegExp(`^${name.replace(/\./g, '\\.')}ChatGPT$`)));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.locator('.app-chat-create-list-item').filter({ hasText: 'My agent' }).first().click();
  await expect(page).toHaveURL(/\/app\/agent-chats\/session%3Aagent%3A/);
  await expect(model).toHaveAccessibleName('Select model, current GPT-6.2 Sol');
});

test('a hosted Claude account alone opens on Claude Sonnet 5.5 and offers only the four current Claude models', async ({ page, baseURL }) => {
  // The account stores an older Claude model, which Kordi no longer offers: it opens with the default.
  const { model, effort, menu } = await openRoutelessAgentChat(page, baseURL!, { provider: 'anthropic', authChoice: 'cloud-api-key:synthetic-claude', modelHint: 'claude-opus-4-8' });
  await expect(model).toHaveAccessibleName('Select model, current Claude Sonnet 5.5');
  await expect(effort).toHaveAccessibleName('Adjust effort, current Default');
  await model.click();
  await expect(menu.getByRole('button', { name: /^Default/ })).toContainText('Claude Sonnet 5.5');
  await expect(menu.getByRole('button', { name: /^More models/ })).toHaveCount(0);
  await expect(menu.locator('.app-model-picker-list .app-model-picker-row'))
    .toHaveText(['Claude Sonnet 5.5', 'Claude Opus 5.5', 'Claude Fable 5.2', 'Claude Haiku 5.5'].map(rowNamed));
});

test('a hosted Google account alone opens on the Google catalog default, and the Default row agrees', async ({ page, baseURL }) => {
  const { model, effort, menu } = await openRoutelessAgentChat(page, baseURL!, { provider: 'google', authChoice: 'cloud-api-key:synthetic-google', modelHint: null });
  await expect(model).toHaveAccessibleName('Select model, current Gemini 3.1 Pro Preview');
  await expect(effort).toHaveAccessibleName('Adjust effort, current Default');
  await model.click();
  await expect(menu.getByRole('button', { name: /^Default/ })).toContainText('Gemini 3.1 Pro Preview');
});
