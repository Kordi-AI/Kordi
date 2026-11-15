import { HelpEmptyExample } from '@/features/onboarding/HelpEmptyExample';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, Bot, Check, Hammer, LoaderCircle, Plus, Puzzle, Wrench } from 'lucide-react';

import { SessionPanelPortal } from '@/app/SessionPanelPortal';
import { useSessionPanelSlot } from '@/app/sessionPanelSlot';
import { SidebarListHeader, SidebarSearchField } from '@/components/SidebarListChrome';
import { ErrorLine } from '@/components/ui/ErrorLine';
import { cn } from '@/lib/utils';
import type { DesktopSkillLibraryEntry } from '@/lib/desktop';
import type { DesktopAgentBuilderSummary } from '@/lib/desktopAgentBuilderCatalog';
import { IdentityAvatar } from '../components/IdentityAvatar';
import type { Agent } from '../types';
import { FactoryLibraryFilterMenu } from './FactoryLibraryFilterMenu';
import { formatInstallCount, installedCommunityMatch, libraryKindLabel } from './factoryLibraryUtils';
import {
  communityProviderLabel,
  type FactoryArtifactKind,
  type FactoryLibraryArtifact,
  type FactoryLibraryFilter,
  type FactoryLibrarySection,
  type FactorySection,
} from './model';
import type { CommunitySkillCatalog } from './useCommunitySkillCatalog';
import { useDismissibleDetails } from './useDismissibleDetails';

const ARTIFACT_ICONS = {
  agent: Bot,
  skill: Puzzle,
  tool: Wrench,
  plugin: Blocks,
} satisfies Record<FactoryArtifactKind, typeof Bot>;

function artifactLabel(kind: string) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function AgentStudioRail({
  agents,
  activeAgentId,
  builds,
  activeBuildSessionId,
  skills,
  libraryArtifacts,
  selectedLibraryId,
  section,
  libraryFilter,
  community,
  canCreateAgent,
  onSectionChange,
  onLibraryFilterChange,
  onOpenBuild,
  onOpenAgent,
  onOpenLibraryArtifact,
  onCreateArtifact,
}: {
  agents: Agent[];
  activeAgentId: string;
  builds: DesktopAgentBuilderSummary[];
  activeBuildSessionId: string | null;
  skills: DesktopSkillLibraryEntry[];
  libraryArtifacts: Record<'tool' | 'plugin', FactoryLibraryArtifact[]>;
  selectedLibraryId: string | null;
  section: FactorySection;
  libraryFilter: FactoryLibraryFilter;
  community: Pick<CommunitySkillCatalog, 'providers' | 'query' | 'setQuery' | 'browsing' | 'results' | 'loading' | 'error' | 'selected' | 'select'>;
  canCreateAgent: boolean;
  onSectionChange: (section: FactorySection) => void;
  onLibraryFilterChange: (filter: FactoryLibraryFilter) => void;
  onOpenBuild: (build: DesktopAgentBuilderSummary) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenLibraryArtifact: (kind: FactoryLibrarySection, artifactId: string) => void;
  onCreateArtifact: (kind: FactoryArtifactKind) => void;
}) {
  const [queries, setQueries] = useState<Record<string, string>>({});
  const { open: menuOpen, close: closeMenu, detailsRef: menuDetailsRef, summaryRef: menuSummaryRef, onToggle: onMenuToggle } = useDismissibleDetails();
  const listRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef<Record<string, number>>({});
  const showingCommunity = section === 'library' && libraryFilter.scope === 'community';
  const librarySection: FactoryLibrarySection = libraryFilter.scope === 'mine' ? libraryFilter.kind : 'skill';
  const viewKey = section !== 'library' ? section
    : libraryFilter.scope === 'community' ? `${section}:community:${libraryFilter.provider}` : `${section}:${libraryFilter.kind}`;
  const query = showingCommunity ? community.query : queries[viewKey] ?? '';
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const filteredBuilds = useMemo(() => builds.filter((build) => (
    !normalizedQuery || [build.name, build.artifactKind, build.lifecycle]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )), [builds, normalizedQuery]);
  const filteredAgents = useMemo(() => agents.filter((agent) => (
    !normalizedQuery || [agent.name, agent.role, agent.status]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )), [agents, normalizedQuery]);
  const skillArtifacts = useMemo<FactoryLibraryArtifact[]>(() => skills.map((skill) => ({
    id: skill.id,
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    status: skill.enabled ? '' : 'Disabled',
    usedBy: agents.filter((agent) => agent.loadedSkills.includes(skill.name)).map((agent) => agent.name),
  })), [agents, skills]);
  const currentLibrary = librarySection === 'skill' ? skillArtifacts : libraryArtifacts[librarySection];
  const filteredLibrary = useMemo(() => currentLibrary.filter((artifact) => (
    !normalizedQuery || [artifact.name, artifact.description, artifact.status, ...artifact.usedBy]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )), [currentLibrary, normalizedQuery]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const frame = window.requestAnimationFrame(() => {
      list.scrollTop = scrollPositionsRef.current[viewKey] ?? 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [viewKey]);

  const createItems: Array<{ kind: FactoryArtifactKind; label: string; detail: string }> = [
    { kind: 'agent', label: 'New agent', detail: 'Shape a private agent draft' },
    { kind: 'skill', label: 'New skill', detail: 'Add reusable guidance' },
    { kind: 'tool', label: 'New tool', detail: 'Define a focused capability' },
    { kind: 'plugin', label: 'New plugin', detail: 'Package an integration' },
  ];
  const libraryCounts = { skill: skills.length, tool: libraryArtifacts.tool.length, plugin: libraryArtifacts.plugin.length };
  const searchPlaceholder = section === 'build' ? 'Search builds'
    : section === 'agents' ? 'Search agents'
      : libraryFilter.scope === 'community' ? `Search ${communityProviderLabel(libraryFilter.provider)}`
        : `Search ${libraryKindLabel(libraryFilter.kind).toLocaleLowerCase()}`;

  // In the app the rail lives in the sidebar session panel, like the Chats list.
  const inSidebar = useSessionPanelSlot() !== null;
  return (
    <SessionPanelPortal>
    <aside className={cn('app-agent-studio-rail', inSidebar && 'app-sidebar-list-content is-in-sidebar')}>
      <header className="app-agent-studio-rail-head">
        <SidebarListHeader title="Factory">
          <details
            ref={menuDetailsRef}
            className="app-factory-create-menu"
            onToggle={onMenuToggle}
          >
            <summary
              ref={menuSummaryRef}
              className="app-agent-studio-rail-add app-icon-button app-utility-button grid h-8 w-8 place-items-center rounded-[10px] p-0 transition"
              title="Start a new Factory build"
              aria-label="Start a new Factory build"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <Plus className="h-4 w-4 stroke-[2.2]" aria-hidden="true" />
            </summary>
            <div className="app-factory-create-menu-panel" role="menu" aria-label="Create in Factory">
              {createItems.map((item) => {
                const Icon = ARTIFACT_ICONS[item.kind];
                return (
                  <button
                    key={item.kind}
                    type="button"
                    role="menuitem"
                    disabled={item.kind === 'agent' && !canCreateAgent}
                    onClick={() => {
                      closeMenu();
                      onCreateArtifact(item.kind);
                    }}
                  >
                    <Icon className="h-4 w-4" />
                    <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                  </button>
                );
              })}
            </div>
          </details>
        </SidebarListHeader>
        <div className="app-factory-rail-switch" role="tablist" aria-label="Factory navigation">
          <button type="button" role="tab" aria-selected={section === 'build'} className={cn(section === 'build' && 'is-active')} onClick={() => onSectionChange('build')}>Build</button>
          <button type="button" role="tab" aria-selected={section === 'agents'} className={cn(section === 'agents' && 'is-active')} onClick={() => onSectionChange('agents')}>Agents <span>{agents.length}</span></button>
          <button type="button" role="tab" aria-selected={section === 'library'} className={cn(section === 'library' && 'is-active')} onClick={() => onSectionChange('library')}>Library <span>{libraryCounts.skill + libraryCounts.tool + libraryCounts.plugin}</span></button>
        </div>
        <SidebarSearchField
          className="app-factory-rail-search"
          value={query}
          onChange={(value) => {
            if (showingCommunity) community.setQuery(value);
            else setQueries((current) => ({ ...current, [viewKey]: value }));
          }}
          placeholder={searchPlaceholder}
          trailing={section === 'library' ? (
            <FactoryLibraryFilterMenu filter={libraryFilter} counts={libraryCounts} providers={community.providers} onChange={onLibraryFilterChange} />
          ) : undefined}
        />
      </header>
      <div
        ref={listRef}
        className="app-agent-studio-agent-list app-scroll-area is-agent-list"
        onScroll={(event) => { scrollPositionsRef.current[viewKey] = event.currentTarget.scrollTop; }}
      >
        {section === 'build' ? filteredBuilds.map((build) => (
          <button key={build.sessionId} type="button" aria-current={activeBuildSessionId === build.sessionId ? 'true' : undefined} className={cn('app-agent-studio-agent-row is-compact', activeBuildSessionId === build.sessionId && 'app-session-row-active')} onClick={() => onOpenBuild(build)}>
            <strong>{build.name}</strong>
            <span className={cn('app-agent-studio-agent-state', !build.available && 'is-warning')}>{build.available ? artifactLabel(build.artifactKind) : 'Recover'}</span>
          </button>
        )) : null}
        {section === 'agents' ? filteredAgents.map((agent) => {
          const capabilityCount = agent.loadedSkills.length + agent.loadedTools.length + agent.loadedPlugins.length;
          return (
            <button key={agent.id} type="button" aria-current={agent.id === activeAgentId ? 'true' : undefined} className={cn('app-agent-studio-agent-row', agent.id === activeAgentId && 'app-session-row-active')} onClick={() => onOpenAgent(agent.id)}>
              <IdentityAvatar kind="agent" seed={agent.avatarSeed ?? agent.id} name={agent.name} imageUrl={agent.profileImageUrl} className="h-9 w-9" />
              <span className="min-w-0"><strong>{agent.name}</strong><small>{agent.role} · {capabilityCount} capabilities</small></span>
              <span className="app-agent-studio-agent-state">{agent.status}</span>
            </button>
          );
        }) : null}
        {showingCommunity ? (
          <>
            {community.browsing && community.results.length > 0 ? <div className="app-factory-rail-label">Popular</div> : null}
            {community.results.map((result) => {
              const active = community.selected?.id === result.id;
              const installed = result.installed || Boolean(installedCommunityMatch(skills, result));
              return (
                <button key={result.id} type="button" aria-current={active ? 'true' : undefined} className={cn('app-agent-studio-agent-row is-community', active && 'app-session-row-active')} onClick={() => community.select(result.id)}>
                  <span className="min-w-0"><strong>{result.name}</strong><small>{result.owner ? `${result.owner} · ` : ''}{formatInstallCount(result.downloads)} installs</small></span>
                  {installed ? <Check className="app-factory-rail-installed h-3.5 w-3.5" aria-label="Installed" /> : null}
                </button>
              );
            })}
            {community.loading && community.results.length === 0 ? <div className="app-agent-studio-rail-empty"><LoaderCircle className="mx-auto h-4 w-4 animate-spin" aria-label="Loading" /></div> : null}
            {community.error ? <ErrorLine className="mx-1 mt-1 px-2.5 py-[7px]">{community.error}</ErrorLine> : null}
            {!community.loading && !community.error && community.results.length === 0 ? <div className="app-agent-studio-rail-empty">No matching skills</div> : null}
          </>
        ) : null}
        {section === 'library' && !showingCommunity ? filteredLibrary.map((artifact) => (
          <button key={artifact.id} type="button" aria-current={artifact.id === selectedLibraryId ? 'true' : undefined} className={cn('app-agent-studio-agent-row is-compact', artifact.id === selectedLibraryId && 'app-session-row-active', artifact.kind === 'skill' && artifact.status === 'Disabled' && 'is-disabled')} onClick={() => onOpenLibraryArtifact(artifact.kind, artifact.id)}>
            <strong>{artifact.name}</strong>
            {artifact.kind === 'skill' && artifact.status === 'Disabled' ? <span className="app-agent-studio-agent-state">Disabled</span> : null}
          </button>
        )) : null}
        {section === 'build' && filteredBuilds.length === 0 ? <div className="app-agent-studio-rail-empty">{agents.length === 0 ? <HelpEmptyExample kind="agents" /> : null}<Hammer className="mx-auto mb-2 h-4 w-4" />Start a build with the + button.</div> : null}
        {section === 'agents' && filteredAgents.length === 0 ? <div className="app-agent-studio-rail-empty">{agents.length === 0 ? <HelpEmptyExample kind="agents" /> : null}No agents match this search.</div> : null}
        {section === 'library' && !showingCommunity && filteredLibrary.length === 0 ? <div className="app-agent-studio-rail-empty">{normalizedQuery ? `No ${librarySection}s match` : `No ${librarySection}s yet`}</div> : null}
      </div>
    </aside>
    </SessionPanelPortal>
  );
}
