import './previewChatTheme';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setSessionPanelSlot } from '../../src/app/sessionPanelSlot';
import { AgentStudioRail } from '../../src/kordi-app/agents/AgentStudioRail';
import { CapabilityLibraryView } from '../../src/kordi-app/agents/CapabilityLibraryView';
import { CommunitySkillDetail } from '../../src/kordi-app/agents/CommunitySkillDetail';
import type { FactoryLibraryArtifact, FactoryLibraryFilter, FactoryLibrarySection } from '../../src/kordi-app/agents/model';
import { useCommunitySkillCatalog } from '../../src/kordi-app/agents/useCommunitySkillCatalog';
import type { DesktopCommunitySkillSummary, DesktopSkillLibraryEntry } from '../../src/lib/desktop';
import '../../src/index.css';

// The Factory Library: the filter menu in the search field, installed and community
// skills in the rail, and the tabbed detail pane. Offline sample data only.
// ?theme=light|dark, ?filter=community, ?tab=SKILL.md
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.body.className = `kordi-app theme-${theme}`;
document.documentElement.classList.toggle('dark', theme === 'dark');
document.documentElement.style.colorScheme = theme;

const skill = (name: string, description: string, overrides: Partial<DesktopSkillLibraryEntry> = {}): DesktopSkillLibraryEntry => ({
  id: `skill:${name}`, name, description, sourceLabel: 'global skill', sourcePath: `/fixture/skills/${name}/SKILL.md`,
  scope: 'global', origin: 'installed', enabled: true, editable: true, removable: true, version: '1.0.0',
  provider: null, owner: null, sourceUrl: null, digest: null, fileCount: 1, ...overrides,
});
const skills: DesktopSkillLibraryEntry[] = [
  skill('adapt', 'Rewrite a draft, design or document for a new audience, format or length while keeping its structure and voice.', { version: '1.3.0', fileCount: 3 }),
  skill('arxiv-digest', 'Summarize new arXiv papers in chosen categories into a short daily digest with links.', { provider: 'clawhub', owner: 'paper-trail', version: '0.4.2' }),
  skill('code-review', 'Review a diff or pull request for correctness bugs and report findings by severity.', { version: '0.9.0' }),
  skill('meeting-notes', 'Turn a transcript into decisions, owners and follow-ups.', { origin: 'built', version: null }),
  skill('tikz-diagrams', 'Create and render TikZ diagrams for papers and slides.', { enabled: false, version: '0.8.0' }),
];
const adaptFiles = ['SKILL.md', 'examples/before-after.md', 'references/tone-presets.md'];
const adaptSkillMd = `---
name: adapt
description: Rewrite a draft, design or document for a new audience, format or length while keeping its structure and voice.
---

# Adapt

Use this skill when the user wants an existing piece reshaped rather than written from scratch.

## When to use

- A document needs a shorter, longer or differently structured version.
- The same content must reach a different audience.

## Steps

1. Read the source in full and list its sections, claims and tone.
2. Keep every claim that survives the new format; cut the rest.
3. Return the adapted piece, then a short list of what was removed.
`;
const community = (name: string, owner: string, downloads: number, description: string): DesktopCommunitySkillSummary => ({
  id: `clawhub:${owner}:${name}`, provider: 'clawhub', owner, slug: name, name, description, version: '1.0.0',
  downloads, stars: 0, sourceUrl: `https://clawhub.example/${owner}/skills/${name}`, installed: false,
});
const popular = [
  community('figma-to-code', 'pixel-forge', 21500, 'Turn a Figma frame link into React components that follow the project tokens.'),
  community('remotion-video', 'studio-labs', 18200, 'Build programmatic videos with Remotion compositions, props and render settings.'),
  community('notion-sync', 'workspace-tools', 9800, 'Mirror selected Notion pages into Markdown and push edits back.'),
  { ...community('arxiv-digest', 'paper-trail', 3200, 'Summarize new arXiv papers into a short daily digest.'), installed: true },
];

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'desktop_skill_library_detail') {
      const entry = skills.find((item) => item.id === args.skillId) ?? skills[0];
      const files = entry.name === 'adapt' ? adaptFiles : ['SKILL.md'];
      return { skill: entry, files: files.map((path) => ({ path, size: 400, text: true })), skillMd: entry.name === 'adapt' ? adaptSkillMd : `# ${entry.name}\n\n${entry.description}\n` };
    }
    if (command === 'desktop_skill_library_read_file') return `# ${String(args.path)}\n\nReference material.\n`;
    if (command === 'desktop_skill_community_providers') return ['clawhub', 'skills-sh'];
    if (command === 'desktop_skill_community_popular') return popular;
    if (command === 'desktop_skill_community_search') return popular.filter((item) => item.name.includes(String(args.query)));
    if (command === 'desktop_skill_community_detail') {
      const summary = popular.find((item) => item.slug === args.slug) ?? popular[0];
      const flagged = summary.slug === 'notion-sync';
      return {
        skill: summary,
        files: [{ path: 'SKILL.md', size: 300, text: `# ${summary.name}\n\n${summary.description}\n` }, { path: 'scripts/sync.py', size: 200, text: 'print("sync")\n' }],
        skillMd: `# ${summary.name}\n\n${summary.description}\n`,
        securityStatus: flagged ? 'suspicious' : 'clean',
        securitySummary: flagged ? 'Sends page content to an outside service and stores a token in the skill folder.' : 'Clean.',
        digest: null,
        reviewDigest: 'fixture',
      };
    }
    throw Error(`Unexpected fixture command ${command}`);
  },
};

const tools: FactoryLibraryArtifact[] = ['bash', 'read_file', 'web_fetch'].map((name) => ({ id: `tool:${name}`, kind: 'tool', name, description: 'Runtime tool used by 1 agent.', status: 'Available', usedBy: ['Kordi'] }));

function Fixture() {
  const [library, setLibrary] = useState(skills);
  const [scope, setScope] = useState<FactoryLibraryFilter['scope']>(params.get('filter') === 'community' ? 'community' : 'mine');
  const [kind, setKind] = useState<FactoryLibrarySection>('skill');
  const [selected, setSelected] = useState<Partial<Record<FactoryLibrarySection, string>>>({});
  const catalog = useCommunitySkillCatalog(scope === 'community', true);
  const filter: FactoryLibraryFilter = scope === 'community' ? { scope, provider: catalog.provider } : { scope, kind };
  const ids = kind === 'skill' ? library.map((item) => item.id) : kind === 'tool' ? tools.map((item) => item.id) : [];
  const selectedId = selected[kind] && ids.includes(selected[kind]!) ? selected[kind]! : ids[0] ?? null;
  const selectedSkill = kind === 'skill' ? library.find((item) => item.id === selectedId) ?? null : null;
  const artifact: FactoryLibraryArtifact | null = selectedSkill
    ? { id: selectedSkill.id, kind: 'skill', name: selectedSkill.name, description: selectedSkill.description, status: '', usedBy: ['Kordi'] }
    : tools.find((item) => item.id === selectedId) ?? null;
  const setEnabled = (entry: DesktopSkillLibraryEntry, enabled: boolean) => {
    setLibrary((current) => current.map((item) => (item.id === entry.id ? { ...item, enabled } : item)));
  };

  return (
    <div className="flex h-screen" style={{ background: 'var(--app-window-bg, var(--utility-background))' }}>
      <aside className="app-side-shell app-workspace-sidebar overflow-hidden" style={{ width: 300 }}>
        <div className="app-session-panel h-full min-h-0 overflow-hidden" style={{ width: 300 }}>
          <div className="app-sidebar-list-content flex h-full flex-col p-2.5">
            <div ref={setSessionPanelSlot} className="app-session-panel-slot flex h-full min-h-0 flex-col" />
          </div>
        </div>
      </aside>
      <div className="app-agents-page app-agent-studio-page relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="app-agent-studio-shell">
          <AgentStudioRail
            agents={[]}
            activeAgentId=""
            builds={[]}
            activeBuildSessionId={null}
            skills={library}
            libraryArtifacts={{ tool: tools, plugin: [] }}
            selectedLibraryId={selectedId}
            section="library"
            libraryFilter={filter}
            community={catalog}
            canCreateAgent
            onSectionChange={() => undefined}
            onLibraryFilterChange={(next) => {
              setScope(next.scope);
              if (next.scope === 'mine') setKind(next.kind);
              else catalog.setProvider(next.provider);
            }}
            onOpenBuild={() => undefined}
            onOpenAgent={() => undefined}
            onOpenLibraryArtifact={(nextKind, id) => { setKind(nextKind); setSelected((current) => ({ ...current, [nextKind]: id })); }}
            onCreateArtifact={() => undefined}
          />
          {scope === 'community' ? (
            <CommunitySkillDetail
              key={catalog.selected?.id ?? 'none'}
              summary={catalog.selected}
              loadingList={catalog.loading}
              installedSkills={library}
              onInstalled={(id) => catalog.markInstalled(id)}
              onSetEnabled={setEnabled}
            />
          ) : (
            <CapabilityLibraryView
              key={`${kind}:${selectedId ?? 'none'}`}
              kind={kind}
              artifact={artifact}
              skill={selectedSkill}
              onSetEnabled={setEnabled}
              onRemove={(entry) => { setLibrary((current) => current.filter((item) => item.id !== entry.id)); return true; }}
              onEditInBuild={() => undefined}
            />
          )}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
