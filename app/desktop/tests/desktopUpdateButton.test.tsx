import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React, { act, createElement, useState } from 'react';
import { useSidebarUpdater, type SidebarUpdaterProps } from '../src/pages/workspaceSidebar.update';
import type { DesktopUpdaterState } from '../src/features/updates/desktopUpdater';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { HelpEntry } from '../src/features/onboarding/HelpEntry';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { desktopUpdateButtonPresentation, WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import type { Conversation } from '../src/kordi-app/types';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

function conversation(): Conversation {
  return {
    id: 'session:main',
    canonicalSessionId: 'session:main',
    name: 'Main',
    type: 'group',
    subtitle: 'hi',
    unread: 0,
    collaborationSources: [],
    trust: 'Cloud',
    directness: 'Group',
    participants: ['Me'],
    messages: [{ role: 'person', sender: 'Me', text: 'hi', time: '09:00' }],
    updatedAtLabel: '09:00',
  };
}

function sidebarProps(overrides: Record<string, unknown> = {}) {
  const chatConversations = [conversation()];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const props = {
    isNativeShell: true,
    isSingleWorkspacePage: false,
    collapseChatSessions: false,
    showSessionRail: true,
    sessionRailWidth: 248,
    activeNav: 'chats',
    setActiveNav: () => {},
    chatConversations,
    onCreateChatSession: () => {},
    chatSearch: '',
    setChatSearch: () => {},
    isDesktopChatLoading: false,
    desktopChatError: null,
    filteredConversations: chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    agentParticipantSpaces: [],
    activeConvId: 'session:main',
    onSelectChatSession: () => {},
    onStartChatWithPerson: () => {},
    onStartChatWithAgent: () => {},
    onCreateChatGroup: () => {},
    onAddContactByNodeId: () => {},
    onCreateChatSessionInParticipantSpace: () => {},
    onRenameChatGroup: () => {},
    onAddChatGroupMembers: () => {},
    onRemoveChatGroupMember: () => {},
    onSetChatGroupAdmin: () => {},
    onDeleteChatSession: () => {},
    onCreateProjectFromFolder: () => {},
    onCreateProject: () => {},
    runtimeProjects: [],
    projectSearch: '',
    setProjectSearch: () => {},
    filteredProjects: [],
    activeProjectId: '',
    activeProjectSessionId: '',
    projectSelectedSessionIds: {},
    selectProject: () => {},
    expandedProjectIds: {},
    setExpandedProjectIds: () => {},
    onSelectProjectSession: () => {},
    groupedContacts: [],
    displayedContacts: [],
    addableContacts: [],
    contactRequestCount: 0,
    setActiveContactGroup: () => {},
    setActiveContactId: () => {},
    displayedAgents: [],
    activeCollaborationHost: null,
    localProfileAvatarSeed: 'me',
    isCollaborationSyncing: false,
    onRefreshBridge: () => {},
    onCopyBridgeHostUrl: () => {},
    onCreateBridgeDraft: () => {},
    ...overrides,
  };
  return {
    layout: props,
    chats: props,
    projects: props,
    directory: props,
    account: props,
  };
}

test('WorkspaceSidebar exposes updates through Help without a separate rail button', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, sidebarProps({
    onCheckForUpdates: async () => ({ status: 'up-to-date' }),
  }) as never));
  const navigation = readFileSync(new URL('../src/pages/workspaceSidebar.navigation.tsx', import.meta.url), 'utf8');
  const help = readFileSync(new URL('../src/features/onboarding/HelpMenu.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(markup, /app-update-wave-button|blob-wave/);
  assert.match(navigation, /<HelpEntry\s+updateAction=\{menuAction\}/);
  assert.ok(help.indexOf('{updateAction ?') > help.indexOf('Contact support'));
  for (const updateAvailable of [false, true]) {
    const helpMarkup = renderToStaticMarkup(<HelpEntry activeNav="chats" setActiveNav={() => {}}
      account={{ localProfileAvatarSeed: 'preview' }} onOpenSession={() => {}}
      updateAction={{ updateAvailable, label: updateAvailable ? 'Update available' : 'Check for updates', onClick: () => {} }} />);
    assert.equal(helpMarkup.includes('bg-red-500'), updateAvailable);
    assert.equal(helpMarkup.includes('Help &amp; setup: update available'), updateAvailable);
  }
});

test('the Help update row describes checking, availability, progress, and retry states', () => {
  const labels: [DesktopUpdaterState, string][] = [
    [{ status: 'idle' }, 'Check for updates'],
    [{ status: 'up-to-date' }, 'Check for updates'],
    [{ status: 'checking' }, 'Checking for updates…'],
    [{ status: 'available', latestVersion: '1.2.3' }, 'Update available'],
    [{ status: 'downloading' }, 'Downloading update…'],
    [{ status: 'installing' }, 'Installing update…'],
    [{ status: 'relaunching' }, 'Restarting Kordi…'],
    [{ status: 'ready', latestVersion: '1.2.3' }, 'Restart to update'],
    [{ status: 'misplaced', latestVersion: '1.2.3' }, 'Move Kordi to Applications'],
    [{ status: 'failed', failureStage: 'check' }, 'Check for updates'],
    [{ status: 'failed', failureStage: 'install' }, 'Retry update'],
  ];
  for (const [state, title] of labels) {
    assert.equal(desktopUpdateButtonPresentation(state).title, title);
  }
});

function UpdateHarness(props: SidebarUpdaterProps) {
  const { menuAction, popover } = useSidebarUpdater(props);
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Help</button>
    {open && menuAction ? <button data-update-action onClick={(event) => {
      menuAction.onClick(event);
      setOpen(false);
    }}>{menuAction.label}</button> : null}
    {popover}
  </>;
}

async function clickButton(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find((item) =>
    item.getAttribute('aria-label') === label || item.textContent === label);
  assert.ok(button, `Missing button: ${label}`);
  await act(async () => button.click());
}

test('Help checks manually and keeps the update dialog alive after the menu closes', async () => {
  await withJsdomRoot(async (mount) => {
    let checks = 0;
    let installs = 0;
    let publish: (state: DesktopUpdaterState) => void = () => {};
    await mount(<UpdateHarness isNativeShell onCheckForUpdates={async () => {
      checks += 1;
      return checks === 1 ? { status: 'up-to-date' } : { status: 'available', latestVersion: '1.2.3' };
    }} onInstallUpdate={async () => { installs += 1; }} onSubscribeToUpdate={(listener) => {
      publish = listener;
      return () => {};
    }} />);
    assert.equal(checks, 1);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await clickButton('Help');
    await clickButton('Check for updates');
    assert.equal(checks, 2);
    assert.equal(installs, 0);
    assert.equal(document.querySelector('[data-update-action]'), null);
    assert.equal(document.querySelector('[role="dialog"]')?.getAttribute('data-update-state'), 'available');
    await clickButton('Not now');
    await clickButton('Help');
    await clickButton('Update available');
    assert.equal(checks, 2);
    await clickButton('Update now');
    assert.equal(installs, 1);
    await act(async () => publish({ status: 'downloading', receivedBytes: 50, totalBytes: 100 }));
    assert.equal(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '50');
  });
});

test('failed manual checks retry checking without invoking installation', async () => {
  await withJsdomRoot(async (mount) => {
    let checks = 0;
    let installs = 0;
    await mount(<UpdateHarness isNativeShell onCheckForUpdates={async () => {
      checks += 1;
      if (checks < 3) throw new Error('Offline');
      return { status: 'up-to-date' };
    }} onInstallUpdate={async () => { installs += 1; }} />);
    await clickButton('Help');
    await clickButton('Check for updates');
    assert.equal(document.querySelector('[role="dialog"]')?.getAttribute('data-update-state'), 'failed');
    await clickButton('Try again');
    assert.equal(checks, 3);
    assert.equal(installs, 0);
    assert.match(document.body.textContent ?? '', /Kordi is up to date/);
  });
});

test('web mode omits the native update row and does not check', async () => {
  await withJsdomRoot(async (mount) => {
    let checks = 0;
    await mount(<UpdateHarness isNativeShell={false} onCheckForUpdates={async () => {
      checks += 1;
      return { status: 'up-to-date' };
    }} />);
    await clickButton('Help');
    assert.equal(document.querySelector('[data-update-action]'), null);
    assert.equal(checks, 0);
  });
});

test('the update card uses the Kordi for Mac prompt layout without the old popover chrome', () => {
  const source = readFileSync(new URL('../src/pages/workspaceSidebar.updatePopover.tsx', import.meta.url), 'utf8');
  const prompt = readFileSync(new URL('../src/features/onboarding/MacAppPrompt.tsx', import.meta.url), 'utf8');
  assert.match(prompt, /app-transient-surface fixed z-30 w-60 rounded-xl border p-4 text-left text-foreground/);
  assert.match(source, /app-transient-surface app-update-card fixed z-\[180\] w-60 rounded-xl border p-4 text-left text-foreground/);
  assert.match(source, /app-button-primary rounded-lg px-3 py-2 text-xs/);
  assert.doesNotMatch(source, /lucide-react|app-update-popover|tail/);
  const css = readDesktopShellCss();
  assert.doesNotMatch(css, /\.app-update-popover/);
  assert.match(css, /\.app-update-card-fill/);
});

test('a downloaded update opens the card once at the help corner and Not now keeps it closed', async () => {
  await withJsdomRoot(async (mount) => {
    window.localStorage.clear();
    let publish: (state: DesktopUpdaterState) => void = () => {};
    let installs = 0;
    const props: SidebarUpdaterProps = {
      isNativeShell: true,
      onCheckForUpdates: async () => ({ status: 'up-to-date' }),
      onInstallUpdate: async () => { installs += 1; },
      onSubscribeToUpdate: (listener) => { publish = listener; return () => {}; },
    };
    await mount(<UpdateHarness {...props} />);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => publish({ status: 'downloading', latestVersion: '1.2.3', background: true }));
    assert.equal(document.querySelector('[role="dialog"]'), null, 'silent downloads stay silent');
    await act(async () => publish({ status: 'ready', latestVersion: '1.2.3' }));
    const card = document.querySelector('[role="dialog"]');
    assert.equal(card?.getAttribute('data-update-state'), 'ready');
    assert.match(card?.textContent ?? '', /Kordi 1\.2\.3/);
    await clickButton('Not now');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(installs, 0);
    await act(async () => publish({ status: 'ready', latestVersion: '1.2.3' }));
    assert.equal(document.querySelector('[role="dialog"]'), null, 'the same version does not reopen');
    await act(async () => publish({ status: 'ready', latestVersion: '1.2.4' }));
    assert.equal(document.querySelector('[role="dialog"]')?.getAttribute('data-update-state'), 'ready');
    await clickButton('Restart to update');
    assert.equal(installs, 1);
  });
});

test('with automatic updates on, an available update only marks Help instead of opening the card', async () => {
  await withJsdomRoot(async (mount) => {
    window.localStorage.clear();
    let publish: (state: DesktopUpdaterState) => void = () => {};
    await mount(<UpdateHarness isNativeShell onCheckForUpdates={async () => ({ status: 'up-to-date' })}
      onSubscribeToUpdate={(listener) => { publish = listener; return () => {}; }} />);
    await act(async () => publish({ status: 'available', latestVersion: '1.2.3' }));
    assert.equal(document.querySelector('[role="dialog"]'), null);
  });
});

test('a copy outside Applications offers Show in Finder instead of installing', async () => {
  await withJsdomRoot(async (mount) => {
    window.localStorage.clear();
    let publish: (state: DesktopUpdaterState) => void = () => {};
    let reveals = 0;
    let installs = 0;
    await mount(<UpdateHarness isNativeShell onCheckForUpdates={async () => ({ status: 'up-to-date' })}
      onInstallUpdate={async () => { installs += 1; }}
      onRevealUpdateApp={() => { reveals += 1; }}
      onSubscribeToUpdate={(listener) => { publish = listener; return () => {}; }} />);
    await act(async () => publish({ status: 'misplaced', latestVersion: '1.2.3' }));
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Move Kordi to Applications/);
    await clickButton('Show in Finder');
    assert.equal(reveals, 1);
    assert.equal(installs, 0);
  });
});

test('desktop update button is wired through the signed updater controller', () => {
  const desktopSource = readFileSync(new URL('../src/lib/desktop.ts', import.meta.url), 'utf8');
  const tauriSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const sidebarSource = readFileSync(new URL('../src/app/assembleSidebarSlot.tsx', import.meta.url), 'utf8');

  assert.match(desktopSource, /desktopUpdaterController/);
  assert.match(tauriSource, /tauri_plugin_updater/);
  assert.match(tauriSource, /desktop_relaunch_after_update/);
  assert.match(sidebarSource, /checkDesktopForUpdates/);
  assert.match(sidebarSource, /installDesktopUpdate/);
  assert.match(sidebarSource, /subscribeDesktopUpdater/);
});
