import { expect, test, type Page } from '@playwright/test';
import { account, isCancelledFixtureRequest } from './apiFixture';
import { installChatFixture } from './chatFixture';

const sessionId = 'session:self-agent:synthetic-browser-project';
const appProject = 'a'.repeat(64);
const siteProject = 'b'.repeat(64);

type Device = { id: string; name: string; online: boolean; projects: { id: string; name: string; sessions: string[] }[] };

async function installProjectFixture(page: Page, baseURL: string, devices: Device[]) {
  const fixture = await installChatFixture(page, baseURL);
  await page.route('**/v1/cloud/agent-provider-auth/snapshots?*', route => route.fulfill({ json: { snapshots: [{
    snapshotId: 'synthetic-agent-provider', provider: 'openai', authChoice: 'api-key', label: 'Synthetic provider',
    modelHint: 'gpt-4.1', createdAt: '2026-11-05T12:00:00Z', revokedAt: null,
  }] } }));
  fixture.conversation.kind = 'ai';
  fixture.conversation.legacy_session_id = sessionId;
  fixture.conversation.members = [fixture.conversation.members[0]];
  fixture.messages[0].sender_account_id = account.accountId;
  fixture.messages[0].content.blocks[0].text = 'Project planning request.';
  const commands: Record<string, unknown>[] = [];
  await page.route('**/v1/cloud/projects**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/cloud/projects') return route.fulfill({ json: { devices } });
    if (path === '/v1/cloud/projects/commands' && request.method() === 'POST') {
      const command = request.postDataJSON() as Record<string, unknown>;
      commands.push(command);
      return route.fulfill({ json: { id: command.commandId, status: 'queued' } });
    }
    const command = commands.find(row => path === `/v1/cloud/projects/commands/${String(row.commandId)}`);
    if (!command) return route.fulfill({ status: 404, json: { message: 'Project action not found.' } });
    // The fixture Mac completes the move and publishes its new catalog.
    for (const project of devices[0].projects) {
      project.sessions = project.sessions.filter(id => id !== command.sessionId);
      if (project.id === command.projectId) project.sessions.push(String(command.sessionId));
    }
    return route.fulfill({ json: { id: command.commandId, status: 'completed', result: { sessionId: command.sessionId } } });
  });
  return { fixture, commands };
}

test('browser Agent Chats lists Mac projects and moves a chat between them', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  const devices: Device[] = [{ id: 'synthetic-mac', name: 'Studio Mac', online: true, projects: [
    { id: appProject, name: 'kordi-app', sessions: [sessionId] },
    { id: siteProject, name: 'website', sessions: [] },
  ] }];
  const { commands } = await installProjectFixture(page, baseURL!, devices);
  await page.goto(`/app/agent-chats/${encodeURIComponent(sessionId)}`);

  const sidebar = page.locator('.chat-project-session-list');
  await expect(sidebar.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
  await expect(sidebar.locator('.chat-project-group', { hasText: 'kordi-app' })).toBeVisible();
  await expect(sidebar.locator('.chat-project-group', { hasText: 'website' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Recents', exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'New project', exact: true })).toHaveCount(0);

  const row = page.getByLabel('Chat workspace');
  const pill = row.getByRole('button', { name: 'Project: kordi-app', exact: true });
  await expect(pill).toBeVisible();
  await expect(row.getByText('Studio Mac', { exact: true })).toBeVisible();
  await expect(row.getByText('Local', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select branch or worktree' })).toHaveCount(0);

  await pill.click();
  const menu = page.getByRole('dialog', { name: 'Choose project' });
  await expect(menu.getByRole('button', { name: 'No project' })).toBeVisible();
  await expect(menu.getByText('New project')).toHaveCount(0);
  await menu.getByRole('button', { name: 'website' }).click();
  await expect.poll(() => commands).toEqual([expect.objectContaining({
    deviceId: 'synthetic-mac', action: 'assign', projectId: siteProject, sessionId,
  })]);
  expect(String(commands[0].commandId)).toMatch(/^[0-9a-f-]{36}$/);
  await expect(menu).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Project: website', exact: true })).toBeVisible();

  await row.getByRole('button', { name: 'Project: website', exact: true }).click();
  await menu.getByRole('button', { name: 'No project' }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).not.toHaveProperty('projectId');
  await expect(row.getByRole('button', { name: 'Choose project', exact: true })).toBeVisible();
  await expect(row.getByText('Studio Mac', { exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Recents', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an offline Mac keeps its projects listed but unavailable, and the server refusal shows inline', async ({ page, baseURL }) => {
  const devices: Device[] = [{ id: 'synthetic-mac', name: 'Studio Mac', online: false, projects: [
    { id: appProject, name: 'kordi-app', sessions: [sessionId] },
    { id: siteProject, name: 'website', sessions: [] },
  ] }];
  await installProjectFixture(page, baseURL!, devices);
  await page.route('**/v1/cloud/projects/commands', route => route.fulfill({ status: 409, json: {
    errorCode: 'project_unavailable', message: 'Open Kordi on the project Mac and try again.',
  } }));
  await page.goto(`/app/agent-chats/${encodeURIComponent(sessionId)}`);
  const row = page.getByLabel('Chat workspace');
  await expect(row.getByText('Studio Mac · Offline', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Project: kordi-app', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Choose project' });
  await expect(menu.getByText('Studio Mac · Offline', { exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'website' })).toBeDisabled();
  await menu.getByRole('button', { name: 'No project' }).click();
  await expect(menu.getByText('Open Kordi on the project Mac and try again.', { exact: true })).toBeVisible();
});

test('without a Mac project the sidebar still has its Projects section and the picker asks to open Kordi on the Mac', async ({ page, baseURL }) => {
  await installProjectFixture(page, baseURL!, []);
  await page.goto(`/app/agent-chats/${encodeURIComponent(sessionId)}`);
  const sidebar = page.locator('.chat-project-session-list');
  await expect(sidebar.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'New project', exact: true })).toHaveCount(0);
  await page.getByLabel('Chat workspace').getByRole('button', { name: 'Choose project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Choose project' }).getByText('Open Kordi on your Mac to use its projects here.')).toBeVisible();
});
