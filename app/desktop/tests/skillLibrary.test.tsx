import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentStudioRail } from '../src/kordi-app/agents/AgentStudioRail';
import { skillLibraryFileDisplay } from '../src/kordi-app/agents/model';
import type { Agent } from '../src/kordi-app/types';
import type { DesktopSkillLibraryEntry } from '../src/lib/desktop';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

const builtSkill: DesktopSkillLibraryEntry = {
  id: 'skill:review',
  name: 'repository-review',
  description: 'Review repository changes with a focused checklist.',
  sourceLabel: 'global skill',
  sourcePath: '/tmp/.kordi/skills/repository-review/SKILL.md',
  scope: 'global',
  origin: 'built',
  enabled: false,
  editable: true,
  removable: true,
  version: null,
  provider: null,
  owner: null,
  sourceUrl: null,
  digest: null,
  fileCount: 1,
};

const externalUiSkill: DesktopSkillLibraryEntry = {
  ...builtSkill,
  id: 'skill:adapt',
  name: 'adapt',
  description: 'Adapt interface designs across screen sizes and responsive layouts.',
  sourceLabel: 'Settings:External',
  sourcePath: '/tmp/.agents/skills/adapt/SKILL.md',
  scope: 'shared',
  origin: 'external',
};

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent:kordi',
    name: 'Kordi',
    role: 'Personal agent',
    messaging: 'Local runtime',
    status: 'Active',
    tasks: 0,
    defaultProvider: 'OpenAI',
    defaultModel: 'gpt-test',
    collaborationConfig: 'Local runtime',
    contactId: 'agent:kordi',
    systemPrompt: '',
    xMd: '',
    identityFiles: [],
    loadedTools: [],
    loadedSkills: [],
    loadedPlugins: [],
    lastActivities: [],
    isOwned: true,
    ...overrides,
  };
}

function communityProps(overrides: Partial<React.ComponentProps<typeof AgentStudioRail>['community']> = {}): React.ComponentProps<typeof AgentStudioRail>['community'] {
  return {
    providers: ['clawhub', 'skills-sh'],
    query: '',
    setQuery: () => undefined,
    browsing: true,
    results: [],
    loading: false,
    error: null,
    selected: null,
    select: () => undefined,
    ...overrides,
  };
}

function railProps(overrides: Partial<React.ComponentProps<typeof AgentStudioRail>> = {}): React.ComponentProps<typeof AgentStudioRail> {
  return {
    agents: [],
    activeAgentId: '',
    builds: [],
    activeBuildSessionId: null,
    skills: [],
    libraryArtifacts: { tool: [], plugin: [] },
    selectedLibraryId: null,
    section: 'build',
    libraryFilter: { scope: 'mine', kind: 'skill' },
    community: communityProps(),
    canCreateAgent: true,
    onSectionChange: () => undefined,
    onLibraryFilterChange: () => undefined,
    onOpenBuild: () => undefined,
    onOpenAgent: () => undefined,
    onOpenLibraryArtifact: () => undefined,
    onCreateArtifact: () => undefined,
    ...overrides,
  };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  return {
    dom,
    restore() {
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

test('skill file rows do not repeat a root filename as their subtitle', () => {
  assert.deepEqual(skillLibraryFileDisplay('SKILL.md'), { name: 'SKILL.md', parent: null });
  assert.deepEqual(skillLibraryFileDisplay('references/api.md'), { name: 'api.md', parent: 'references' });
});

test('Factory rail exposes Build, Agents, Library and all chat-first artifact kinds', () => {
  const html = renderToStaticMarkup(
    <AgentStudioRail {...railProps({ skills: [builtSkill], section: 'agents' })} />,
  );

  assert.match(html, /New agent/);
  assert.match(html, /New skill/);
  assert.match(html, /New tool/);
  assert.match(html, /New plugin/);
  assert.match(html, />Build<\/button>/);
  assert.match(html, /Agents <span>0<\/span>/);
  assert.match(html, /Library <span>1<\/span>/);
  assert.match(html, /Search agents/);
  assert.doesNotMatch(html, /Factory runtime connected/);
});

test('Factory build rows stay compact and omit decorative icons and private-draft copy', () => {
  const html = renderToStaticMarkup(
    <AgentStudioRail {...railProps({
      section: 'build',
      builds: [{
        draftId: 'draft:one',
        targetKey: 'target:one',
        sessionId: 'session:one',
        artifactKind: 'agent',
        name: 'Research helper',
        lifecycle: 'draft',
        updatedAtMs: 1,
        available: true,
      }],
    })} />,
  );

  assert.match(html, /app-agent-studio-agent-row is-compact/);
  assert.match(html, /<strong>Research helper<\/strong><span class="app-agent-studio-agent-state">Agent<\/span>/);
  assert.doesNotMatch(html, /Private draft|app-agent-studio-draft-avatar/);
});

test('Factory plus menu stays fully inside the narrow rail', () => {
  const css = readDesktopShellCss();
  const panelRule = css.match(/\.app-factory-create-menu-panel\s*\{([^}]*)\}/)?.[1];

  assert.ok(panelRule);
  assert.match(panelRule, /right:\s*-16px;/);
  assert.match(panelRule, /width:\s*min\(224px,\s*calc\(100vw - 24px\)\);/);
});

test('Factory plus menu dismisses outside and restores trigger focus on Escape', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  const outside = document.createElement('button');
  document.body.append(host, outside);
  let root: Root | null = createRoot(host);

  try {
    await act(async () => root?.render(
      <AgentStudioRail {...railProps({ skills: [builtSkill] })} />,
    ));

    const details = host.querySelector<HTMLDetailsElement>('.app-factory-create-menu');
    const summary = host.querySelector<HTMLElement>('.app-agent-studio-rail-add');
    assert.ok(details);
    assert.ok(summary);
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new installed.dom.window.Event('toggle'));
    });
    assert.equal(details.open, true);
    assert.equal(summary.getAttribute('aria-expanded'), 'true');

    await act(async () => {
      outside.dispatchEvent(new installed.dom.window.Event('pointerdown', { bubbles: true }));
    });
    assert.equal(details.open, false);
    assert.equal(summary.getAttribute('aria-expanded'), 'false');

    const firstMenuItem = host.querySelector<HTMLButtonElement>('[role="menuitem"]');
    assert.ok(firstMenuItem);
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new installed.dom.window.Event('toggle'));
    });
    firstMenuItem.focus();
    assert.equal(document.activeElement, firstMenuItem);

    await act(async () => {
      firstMenuItem.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
    assert.equal(details.open, false);
    assert.equal(summary.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, summary);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    outside.remove();
    host.remove();
    installed.restore();
  }
});

test('Factory agent selection uses rounded sidebar rows with matching content insets', () => {
  const html = renderToStaticMarkup(
    <AgentStudioRail {...railProps({ agents: [agent()], activeAgentId: 'agent:kordi', section: 'agents' })} />,
  );
  const css = readDesktopShellCss();

  assert.match(html, /app-agent-studio-agent-list app-scroll-area is-agent-list/);
  assert.match(html, /app-agent-studio-agent-row app-session-row-active/);
  assert.match(
    css,
    /\.app-agent-studio-agent-list\.is-agent-list\s*\{[^}]*padding-inline:\s*0;/s,
  );
  assert.match(
    css,
    /\.app-agent-studio-agent-list\.is-agent-list \.app-agent-studio-agent-row\s*\{[^}]*padding-inline:\s*10px;[^}]*border:\s*0;[^}]*border-radius:\s*10px;/s,
  );
});

test('Library search carries one filter menu for scope and type, and rows say only Disabled', () => {
  const html = renderToStaticMarkup(
    <AgentStudioRail {...railProps({
      skills: [{ ...builtSkill, enabled: true }, { ...externalUiSkill, enabled: false }],
      selectedLibraryId: builtSkill.id,
      section: 'library',
      libraryArtifacts: {
        tool: [{ id: 'tool:read', kind: 'tool', name: 'read', description: '', status: 'Available', usedBy: [] }],
        plugin: [{ id: 'plugin:github', kind: 'plugin', name: 'github', description: '', status: 'Available', usedBy: [] }],
      },
    })} />,
  );

  assert.match(html, /placeholder="Search skills"/);
  assert.match(html, /aria-label="Show: Skills"/);
  assert.match(html, />My library</);
  assert.match(html, /role="menuitemradio" aria-checked="true"><svg[^>]*>.*?<span>Skills<\/span><small>2<\/small>/);
  assert.match(html, /<span>Tools<\/span><small>1<\/small>/);
  assert.match(html, /<span>Plugins<\/span><small>1<\/small>/);
  assert.match(html, />Community</);
  assert.match(html, /<span>ClawHub<\/span>/);
  assert.match(html, /<span>skills\.sh<\/span>/);
  assert.doesNotMatch(html, /app-factory-library-switch|text-transform/);
  assert.match(html, /aria-current="true" class="app-agent-studio-agent-row is-compact app-session-row-active"><strong>repository-review<\/strong><\/button>/);
  assert.match(html, /<strong>adapt<\/strong><span class="app-agent-studio-agent-state">Disabled<\/span>/);
  assert.doesNotMatch(html, /Enabled/);
});

test('Factory rail keys search and scroll return context independently for each peer view', () => {
  const source = readFileSync(new URL('../src/kordi-app/agents/AgentStudioRail.tsx', import.meta.url), 'utf8');

  assert.match(source, /const \[queries, setQueries\] = useState<Record<string, string>>\(\{\}\);/);
  assert.match(source, /`\$\{section\}:community:\$\{libraryFilter\.provider\}`/);
  assert.match(source, /setQueries\(\(current\) => \(\{ \.\.\.current, \[viewKey\]: value \}\)\)/);
  assert.equal(source.match(/scrollPositionsRef\.current\[viewKey\]/g)?.length, 2);
});

test('Community results fill the rail list, opening on Popular before a search', () => {
  const result = {
    id: 'clawhub:pixel-forge:figma-to-code',
    provider: 'clawhub',
    owner: 'pixel-forge',
    slug: 'figma-to-code',
    name: 'figma-to-code',
    description: 'Turn a Figma frame into React components.',
    version: '1.2.0',
    downloads: 21500,
    stars: 0,
    sourceUrl: 'https://clawhub.ai/pixel-forge/skills/figma-to-code',
    installed: true,
  };
  const props = (community: Partial<React.ComponentProps<typeof AgentStudioRail>['community']>) => railProps({
    skills: [builtSkill],
    section: 'library',
    libraryFilter: { scope: 'community', provider: 'clawhub' },
    community: communityProps(community),
  });
  const popular = renderToStaticMarkup(<AgentStudioRail {...props({ results: [result], selected: result })} />);

  assert.match(popular, /placeholder="Search ClawHub"/);
  assert.match(popular, /aria-label="Show: ClawHub"/);
  assert.match(popular, />Popular</);
  assert.match(popular, /<strong>figma-to-code<\/strong><small>pixel-forge · 22K installs<\/small>/);
  assert.match(popular, /aria-label="Installed"/);
  assert.doesNotMatch(popular, /repository-review|Community skills/);

  const searched = renderToStaticMarkup(<AgentStudioRail {...props({ query: 'figma', browsing: false, results: [result] })} />);
  assert.doesNotMatch(searched, />Popular</);
  const empty = renderToStaticMarkup(<AgentStudioRail {...props({ query: 'zzz', browsing: false })} />);
  assert.match(empty, /No matching skills/);
});
