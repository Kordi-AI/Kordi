import { expect, test, type Page } from '@playwright/test';
import { account, isCancelledFixtureRequest } from './apiFixture';
import { installChatFixture } from './chatFixture';

const sessionId = 'session:self-agent:synthetic-project-chat';
const title = 'Draft the release notes';
const releaseId = 'a'.repeat(64);
const macProjects = [
  { id: releaseId, name: 'Release planning', sessions: [sessionId] },
  // Just created on the Mac: its first session has not synced to the browser yet.
  { id: 'b'.repeat(64), name: 'Synthetic notes', sessions: [] },
];

/** One agent chat the browser already has, and the project catalog the account's Macs publish. */
async function installProjectFixture(page: Page, baseURL: string, catalog: { devices: unknown[] }) {
  const fixture = await installChatFixture(page, baseURL);
  fixture.conversation.kind = 'ai';
  fixture.conversation.legacy_session_id = sessionId;
  fixture.conversation.members = [fixture.conversation.members[0]];
  fixture.messages[0].sender_account_id = account.accountId;
  await page.route('**/v2/chat/sync/bootstrap', route => route.fulfill({ json: {
    protocol_version: 2, conversations: [{ ...fixture.conversation, shared_title: title }],
    latest_messages: fixture.messages,
    session_visibility: { hiddenSessionIds: [], deletedSessionIds: [], unreadSessionIds: [], pinnedSessionIds: [], mutedSessionIds: [], pinnedGroupSpaceIds: [] },
    next_cursor: 'project-fixture', last_stream_seq: 1, server_time: '2026-11-05T12:00:00Z',
  } }));
  const catalogRequests: string[] = [];
  await page.route('**/v1/cloud/projects', route => {
    catalogRequests.push(route.request().method());
    return route.fulfill({ json: catalog });
  });
  return { catalogRequests };
}

const sidebar = (page: Page) => page.locator('.chat-project-session-list');
const projectsHeading = (page: Page) => sidebar(page).getByRole('button', { name: 'Projects', exact: true });

async function expectReadOnlyProjects(page: Page) {
  const list = sidebar(page);
  await expect(projectsHeading(page)).toBeVisible();
  for (const project of macProjects) await expect(list.getByRole('button', { name: project.name, exact: true })).toBeVisible();
  await expect(list.locator(`[data-chat-sidebar-row^="project:remote-project:${releaseId}:"]`)).toContainText(title);
  await expect(list.locator('[data-chat-sidebar-row^="recent:"]').filter({ hasText: title })).toHaveCount(0);
  // The browser has no project folders: it never creates, locates or assigns projects.
  await expect(page.getByRole('button', { name: /^(Locate folder|New project|New session in )/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Choose project|Project: )/ })).toHaveCount(0);
}

test('Agent chats list every project the account\'s Macs publish, read-only', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  await page.setViewportSize({ width: 1280, height: 800 });
  const fixture = await installProjectFixture(page, baseURL!, { devices: [
    { id: 'synthetic-mac', name: 'Synthetic Mac', online: true, projects: macProjects },
  ] });
  await page.goto(`/app/agent-chats/${encodeURIComponent(sessionId)}`);
  await expectReadOnlyProjects(page);
  expect(fixture.catalogRequests.every(method => method === 'GET')).toBe(true);
  expect(errors).toEqual([]);
});

test('an account without published projects shows no Projects section until a Mac publishes one', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  const catalog: { devices: unknown[] } = { devices: [] };
  const fixture = await installProjectFixture(page, baseURL!, catalog);
  await page.goto(`/app/agent-chats/${encodeURIComponent(sessionId)}`);
  await expect(sidebar(page).locator('[data-chat-sidebar-row^="recent:"]').filter({ hasText: title })).toBeVisible();
  await expect.poll(() => fixture.catalogRequests.length).toBeGreaterThan(0);
  await expect(projectsHeading(page)).toHaveCount(0);
  // Returning to the tab picks up a project created meanwhile without waiting for the poll.
  catalog.devices = [{ id: 'synthetic-mac', name: 'Synthetic Mac', online: true, projects: macProjects }];
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expectReadOnlyProjects(page);
  expect(errors).toEqual([]);
});
