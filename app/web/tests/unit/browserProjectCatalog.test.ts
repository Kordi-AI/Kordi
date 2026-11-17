import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOUD_SESSION_CHANGED_EVENT, CLOUD_SESSION_SIGNED_OUT_EVENT } from '@/features/cloud/session';
import type { Conversation } from '@/kordi-app/types';
import {
  __setBrowserProjectRequestForTests, assignBrowserProject, browserProjectCatalogSnapshot, browserProjectPicker,
  canChooseBrowserProject, mergeProjectGroups, parseProjectCatalog, projectDeviceForSession, projectPickerDevices,
  refreshBrowserProjects, resetBrowserProjects, subscribeBrowserProjects, type BrowserProjectDevice, type BrowserProjectRequest,
} from '@web/runtime/browserProjectCatalog';

const app = 'a'.repeat(64);
const site = 'b'.repeat(64);
const docs = 'c'.repeat(64);

function catalog(): BrowserProjectDevice[] {
  return parseProjectCatalog({ devices: [
    { id: 'mac-offline', name: 'Old Mac', online: false, projects: [
      { id: app, name: 'app (old)', sessions: ['session:a', 'session:b'] },
      { id: docs, name: 'docs', sessions: [] },
    ] },
    { id: 'mac-online', name: 'Studio Mac', online: true, projects: [
      { id: app, name: 'app', sessions: ['session:b', 'session:c'] },
      { id: site, name: 'site', sessions: [] },
    ] },
    { id: 'mac-empty', name: 'Laptop', online: true, projects: [] },
  ] });
}

test('the catalog keeps only well-formed Macs and projects', () => {
  const devices = parseProjectCatalog({ devices: [
    { id: 'mac', online: true, projects: [
      { id: app, name: ' app ', sessions: ['session:a', 'session:a', '', 7] },
      { id: 'not-a-hash', name: 'bad', sessions: [] },
      { id: site, name: '', sessions: [] },
      { id: docs, name: 'docs' },
    ] },
    { name: 'no id', projects: [] },
    null,
  ] });
  assert.deepEqual(devices, [{ id: 'mac', name: 'Mac', online: true, projects: [{ id: app, name: 'app', sessions: ['session:a'] }] }]);
  assert.deepEqual(parseProjectCatalog(null), []);
  assert.deepEqual(parseProjectCatalog({ devices: 'x' }), []);
});

test('the same folder on several Macs is one project, named and served by an online Mac first', () => {
  const groups = mergeProjectGroups(catalog());
  assert.deepEqual(groups.map((group) => [group.project.name, group.project.sessions, group.devices.map((device) => device.id)]), [
    ['app', ['session:a', 'session:b', 'session:c'], ['mac-online', 'mac-offline']],
    ['docs', [], ['mac-offline']],
    ['site', [], ['mac-online']],
  ]);
  assert.equal(projectDeviceForSession(catalog(), 'session:b')?.id, 'mac-online');
  assert.equal(projectDeviceForSession(catalog(), 'session:a')?.id, 'mac-offline');
  assert.equal(projectDeviceForSession(catalog(), 'session:z'), null);
});

test('the picker lists each project once under an online Mac and keeps offline projects unavailable', () => {
  assert.deepEqual(projectPickerDevices(catalog()).map((device) => [device.id, device.projects.map((project) => project.name)]), [
    ['mac-offline', ['docs']],
    ['mac-online', ['app', 'site']],
  ]);
  const picker = browserProjectPicker(catalog(), 'session:a');
  assert.equal(picker.noProjectDeviceId, 'mac-offline');
  assert.equal(picker.hasProjects, true);
  assert.deepEqual(picker.sections.map(({ device, options }) => [device.id, options.map((option) => [option.project.name, option.selected, option.disabled])]), [
    ['mac-offline', [['docs', false, true]]],
    ['mac-online', [['app', true, false], ['site', false, false]]],
  ]);
  const filtered = browserProjectPicker(catalog(), 'session:new', 'SI');
  assert.equal(filtered.noProjectDeviceId, null);
  assert.deepEqual(filtered.sections.map(({ options }) => options.map((option) => option.project.name)), [['site']]);
  assert.deepEqual(browserProjectPicker([{ id: 'mac', name: 'Mac', online: true, projects: [] }], 'session:a'),
    { noProjectDeviceId: null, sections: [], hasProjects: false });
});

test('assigning prepares the conversation, sends one command and waits for the Mac', async () => {
  const calls: Array<[string, string | undefined, unknown]> = [];
  const statuses = ['queued', 'running', 'completed'];
  const prepared: string[] = [];
  const request: BrowserProjectRequest = async (path, method, body) => {
    calls.push([path, method, body]);
    return path === '/commands' ? { status: 'queued' } : { status: statuses.shift() };
  };
  await assignBrowserProject({ deviceId: 'mac-online', projectId: site, sessionId: 'session:c' }, {
    request, commandId: () => 'command-1', sleep: async () => undefined,
    prepareConversation: async (sessionId) => { prepared.push(sessionId); },
  });
  assert.deepEqual(prepared, ['session:c']);
  assert.deepEqual(calls, [
    ['/commands', 'POST', { commandId: 'command-1', deviceId: 'mac-online', action: 'assign', sessionId: 'session:c', projectId: site }],
    ['/commands/command-1', undefined, undefined],
    ['/commands/command-1', undefined, undefined],
    ['/commands/command-1', undefined, undefined],
  ]);

  calls.length = 0;
  await assignBrowserProject({ deviceId: 'mac-online', projectId: null, sessionId: 'session:c' }, {
    request: async (path, method, body) => { calls.push([path, method, body]); return { status: 'completed' }; },
    commandId: () => 'command-2', sleep: async () => undefined, prepareConversation: async () => undefined,
  });
  assert.deepEqual(calls[0][2], { commandId: 'command-2', deviceId: 'mac-online', action: 'assign', sessionId: 'session:c' });
});

test('a failed or unclaimed action reports why, and a refused command stops before polling', async () => {
  const base = { commandId: () => 'command', sleep: async () => undefined, prepareConversation: async () => undefined };
  const input = { deviceId: 'mac', projectId: app, sessionId: 'session:a' };
  await assert.rejects(assignBrowserProject(input, { ...base,
    request: async (path) => (path === '/commands' ? {} : { status: 'failed', result: { message: 'The folder is missing.' } }),
  }), /The folder is missing\./);
  await assert.rejects(assignBrowserProject(input, { ...base,
    request: async (path) => (path === '/commands' ? {} : { status: 'failed', result: null }),
  }), /could not finish/);
  let clock = 0;
  await assert.rejects(assignBrowserProject(input, { ...base, now: () => clock,
    sleep: async () => { clock += 60_000; },
    request: async () => ({ status: 'queued' }),
  }), /did not respond/);
  let polled = false;
  await assert.rejects(assignBrowserProject(input, { ...base,
    request: async (path) => {
      if (path === '/commands') throw new Error('Open Kordi on the project Mac and try again.');
      polled = true;
      return { status: 'completed' };
    },
  }), /Open Kordi on the project Mac/);
  assert.equal(polled, false);
});

test('the shared catalog drops a response from before an account change', async () => {
  let resolveOld: (value: unknown) => void = () => undefined;
  const old = refreshBrowserProjects(() => new Promise((resolve) => { resolveOld = resolve; }));
  resetBrowserProjects();
  resolveOld({ devices: [{ id: 'mac', name: 'Previous Mac', online: true, projects: [{ id: app, name: 'app', sessions: [] }] }] });
  await old;
  assert.deepEqual(browserProjectCatalogSnapshot(), { devices: [], groups: [], loaded: false, error: null });
  await refreshBrowserProjects(async () => ({ devices: [{ id: 'mac-2', name: 'Current Mac', online: true, projects: [{ id: site, name: 'site', sessions: [] }] }] }));
  assert.deepEqual(browserProjectCatalogSnapshot().groups.map((group) => group.project.name), ['site']);
  await refreshBrowserProjects(async () => { throw new Error('Projects are unavailable. Try again.'); });
  assert.equal(browserProjectCatalogSnapshot().error, 'Projects are unavailable. Try again.');
  assert.deepEqual(browserProjectCatalogSnapshot().groups.map((group) => group.project.name), ['site']);
  resetBrowserProjects();
});

test('switching or signing out of the account clears the catalog while it is shown', async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const target = new EventTarget();
  (globalThis as { window?: unknown }).window = target;
  let account = 'first';
  __setBrowserProjectRequestForTests(async () => ({ devices: account === 'first'
    ? [{ id: 'mac', name: 'First Mac', online: true, projects: [{ id: app, name: 'app', sessions: ['session:a'] }] }]
    : [] }));
  const notified: number[] = [];
  const unsubscribe = subscribeBrowserProjects(() => notified.push(browserProjectCatalogSnapshot().groups.length));
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(browserProjectCatalogSnapshot().groups.length, 1);
    account = 'second';
    target.dispatchEvent(new Event(CLOUD_SESSION_CHANGED_EVENT));
    assert.deepEqual(browserProjectCatalogSnapshot(), { devices: [], groups: [], loaded: false, error: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(browserProjectCatalogSnapshot().loaded, true);
    assert.equal(browserProjectCatalogSnapshot().groups.length, 0);
    account = 'first';
    await refreshBrowserProjects();
    assert.equal(browserProjectCatalogSnapshot().groups.length, 1);
    target.dispatchEvent(new Event(CLOUD_SESSION_SIGNED_OUT_EVENT));
    assert.equal(browserProjectCatalogSnapshot().groups.length, 0);
    assert.ok(notified.includes(0) && notified.includes(1));
  } finally {
    unsubscribe();
    resetBrowserProjects();
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test('only the owner\'s own top-level agent sessions can choose a project', () => {
  const base = { id: 'session:self-agent:one', canonicalSessionId: 'session:self-agent:one', type: 'owned-agent', name: 'Chat',
    subtitle: '', unread: 0, collaborationSources: [], trust: '', directness: '', participants: [], messages: [] } as Conversation;
  assert.equal(canChooseBrowserProject(base), true);
  // Chats started on a Mac keep a bare ID.
  assert.equal(canChooseBrowserProject({ ...base, id: '71c56158-6845-4304-a42b-25bc15f4a305', canonicalSessionId: undefined }), true);
  assert.equal(canChooseBrowserProject({ ...base, agentSubsessionId: 'sub' }), false);
  assert.equal(canChooseBrowserProject({ ...base, type: 'person' }), false);
  assert.equal(canChooseBrowserProject({ ...base, collaborationTarget: { hostId: 'cloud' } as Conversation['collaborationTarget'] }), false);
  assert.equal(canChooseBrowserProject({ ...base, metadata: { personalAgent: { agentId: 'agent:personal' } } }), false);
  assert.equal(canChooseBrowserProject({ ...base, id: 'draft:local-chat', canonicalSessionId: undefined }), false);
});
