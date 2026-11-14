import { useEffect, useRef, useState } from 'react';
import { Blocks, Copy, FolderOpen, Pencil, Puzzle, Trash2, Wrench } from 'lucide-react';

import { ErrorLine } from '@/components/ui/ErrorLine';
import { revealDesktopAttachment } from '@/features/chat/attachmentDesktopActions';
import {
  fetchDesktopSkillLibraryDetail,
  isNativeDesktopShell,
  readDesktopSkillLibraryFile,
  type DesktopSkillLibraryEntry,
} from '@/lib/desktop';
import {
  FactoryDetailHeader,
  FactoryDetailTabs,
  FactoryEnabledSwitch,
  FactoryFileView,
  FactoryMoreMenu,
  FactoryOverview,
  type FactoryDocMode,
  type FactoryMenuItem,
} from './FactoryLibraryDetailParts';
import { factoryErrorMessage, factoryItemMeta, OVERVIEW_TAB, skillFolderPath, skillSource } from './factoryLibraryUtils';
import type { FactoryLibraryArtifact, FactoryLibrarySection } from './model';

const KIND_ICONS = { skill: Puzzle, tool: Wrench, plugin: Blocks } satisfies Record<FactoryLibrarySection, typeof Puzzle>;

function kindLabel(kind: FactoryLibrarySection) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function artifactSource(artifact: FactoryLibraryArtifact) {
  if (artifact.status === 'Published') return 'Kordi Factory';
  return artifact.kind === 'tool' ? 'Built in' : 'Installed';
}

function copyText(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** Inspection of one item from the user's own library: a skill, tool or plugin. */
export function CapabilityLibraryView({
  kind,
  artifact,
  skill,
  mutating = false,
  onSetEnabled,
  onRemove,
  onEditInBuild,
}: {
  kind: FactoryLibrarySection;
  artifact: FactoryLibraryArtifact | null;
  skill?: DesktopSkillLibraryEntry | null;
  mutating?: boolean;
  onSetEnabled?: (skill: DesktopSkillLibraryEntry, enabled: boolean) => Promise<unknown> | void;
  onRemove?: (skill: DesktopSkillLibraryEntry) => Promise<boolean> | boolean;
  onEditInBuild: (artifact: FactoryLibraryArtifact) => void;
}) {
  const [files, setFiles] = useState<Array<{ path: string; text: boolean }>>([]);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [tab, setTab] = useState(OVERVIEW_TAB);
  const [docMode, setDocMode] = useState<FactoryDocMode>('rendered');
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const requestRef = useRef(0);
  const Icon = KIND_ICONS[kind];
  const skillId = skill?.id;
  const skillName = skill?.name;

  useEffect(() => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    if (kind !== 'skill' || !skillId) return undefined;
    void fetchDesktopSkillLibraryDetail(skillId)
      .then((detail) => {
        if (requestRef.current !== request) return;
        const ordered = [...detail.files].sort((left, right) => (
          Number(right.path === 'SKILL.md') - Number(left.path === 'SKILL.md') || left.path.localeCompare(right.path)
        ));
        setFiles(ordered);
        setContents({ 'SKILL.md': detail.skillMd });
      })
      .catch((loadError) => {
        if (requestRef.current === request) setError(factoryErrorMessage(loadError, `Unable to inspect ${skillName ?? 'this skill'}.`));
      });
    return () => { requestRef.current += 1; };
  }, [kind, skillId, skillName]);

  const openTab = async (path: string) => {
    setTab(path);
    if (!skill || path === OVERVIEW_TAB || path in contents) return;
    if (!files.find((file) => file.path === path)?.text) return;
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoadingPath(path);
    setError(null);
    try {
      const text = await readDesktopSkillLibraryFile(skill.id, path);
      if (requestRef.current === request) setContents((current) => ({ ...current, [path]: text }));
    } catch (readError) {
      if (requestRef.current === request) setError(factoryErrorMessage(readError, `Unable to read ${path}.`));
    } finally {
      if (requestRef.current === request) setLoadingPath(null);
    }
  };

  if (!artifact) {
    return <main className="app-agent-studio-main"><div className="app-skill-library-state"><Icon className="h-4 w-4" /><strong>No {kind} selected</strong></div></main>;
  }

  const menuItems: FactoryMenuItem[] = skill ? [
    ...(isNativeDesktopShell() ? [{ label: 'Show in Finder', icon: FolderOpen, onSelect: () => { void revealDesktopAttachment(skill.sourcePath).catch(() => undefined); } }] : []),
    { label: 'Copy path', icon: Copy, onSelect: () => copyText(skillFolderPath(skill)) },
    ...(skill.removable && onRemove ? [{ label: 'Remove', icon: Trash2, danger: true, onSelect: () => setConfirmRemove(true) }] : []),
  ] : [{ label: 'Copy identifier', icon: Copy, onSelect: () => copyText(artifact.name) }];
  const meta = skill
    ? factoryItemMeta('Skill', skillSource(skill), skill.version ? `v${skill.version.replace(/^v/i, '')}` : null)
    : factoryItemMeta(kindLabel(kind), artifactSource(artifact));
  const details: Array<[string, string]> = [['Used by', artifact.usedBy.join(', ') || 'No agent']];
  if (skill) {
    details.push(['Source', skillSource(skill)]);
    if (skill.version) details.push(['Version', skill.version]);
    details.push(['Files', String(files.length || skill.fileCount)]);
  } else {
    details.push(['Source', artifactSource(artifact)], ['Identifier', artifact.name]);
  }
  const activeTab = files.some((file) => file.path === tab) ? tab : OVERVIEW_TAB;

  return (
    <main className="app-agent-studio-main app-factory-inspect-main">
      <FactoryDetailHeader icon={Icon} name={artifact.name} meta={meta}>
        {skill && onSetEnabled ? (
          <>
            <FactoryEnabledSwitch enabled={skill.enabled} disabled={mutating} onChange={(enabled) => { void onSetEnabled(skill, enabled); }} />
            <span className="app-factory-action-divider" aria-hidden="true" />
          </>
        ) : null}
        <button type="button" className="app-button-quiet app-agent-studio-button is-small" onClick={() => onEditInBuild(artifact)}><Pencil className="h-3.5 w-3.5" />Edit in Build</button>
        <FactoryMoreMenu items={menuItems} />
      </FactoryDetailHeader>
      {confirmRemove && skill && onRemove ? (
        <div className="app-factory-confirm" role="alertdialog" aria-label={`Remove ${skill.name}`}>
          <span>Remove {skill.name}?</span>
          <button type="button" className="app-button-quiet app-agent-studio-button is-small" onClick={() => setConfirmRemove(false)}>Cancel</button>
          <button type="button" className="app-button-quiet app-agent-studio-button is-small is-danger" disabled={mutating} onClick={() => { void Promise.resolve(onRemove(skill)).then((removed) => { if (removed) setConfirmRemove(false); }); }}>Remove</button>
        </div>
      ) : null}
      {error ? <ErrorLine className="mx-4 mt-3 px-2.5 py-[7px]">{error}</ErrorLine> : null}
      {files.length > 0 ? (
        <FactoryDetailTabs files={files.map((file) => file.path)} active={activeTab} onChange={(next) => { void openTab(next); }} docMode={docMode} onDocModeChange={setDocMode} />
      ) : null}
      <div className="app-factory-detail-body">
        {activeTab === OVERVIEW_TAB
          ? <FactoryOverview about={artifact.description} details={details} />
          : <FactoryFileView path={activeTab} text={contents[activeTab] ?? null} loading={loadingPath === activeTab} mode={docMode} />}
      </div>
    </main>
  );
}
