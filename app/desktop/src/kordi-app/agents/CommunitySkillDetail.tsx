import { useEffect, useState } from 'react';
import { Check, Download, ExternalLink, Globe2, LoaderCircle } from 'lucide-react';

import { ErrorLine } from '@/components/ui/ErrorLine';
import {
  fetchDesktopCommunitySkillDetail,
  installDesktopCommunitySkill,
  openDesktopExternalUrl,
  type DesktopCommunitySkillDetail,
  type DesktopCommunitySkillSummary,
  type DesktopSkillLibraryEntry,
} from '@/lib/desktop';
import {
  FactoryDetailHeader,
  FactoryDetailTabs,
  FactoryEnabledSwitch,
  FactoryFileView,
  FactoryOverview,
  type FactoryDocMode,
} from './FactoryLibraryDetailParts';
import {
  communitySecurityNotice,
  factoryErrorMessage,
  factoryItemMeta,
  formatInstallCount,
  installedCommunityMatch,
  OVERVIEW_TAB,
} from './factoryLibraryUtils';
import { communityProviderLabel, type FactoryCommunityProvider } from './model';

/** A community skill shown in the same layout as an installed one, with Install in place of the switch. */
export function CommunitySkillDetail({
  summary,
  loadingList,
  installedSkills,
  mutatingSkillId,
  onInstalled,
  onSetEnabled,
}: {
  summary: DesktopCommunitySkillSummary | null;
  loadingList: boolean;
  installedSkills: DesktopSkillLibraryEntry[];
  mutatingSkillId?: string | null;
  onInstalled: (summaryId: string, skill: DesktopSkillLibraryEntry) => Promise<void> | void;
  onSetEnabled?: (skill: DesktopSkillLibraryEntry, enabled: boolean) => Promise<unknown> | void;
}) {
  const [detail, setDetail] = useState<DesktopCommunitySkillDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(summary));
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(OVERVIEW_TAB);
  const [docMode, setDocMode] = useState<FactoryDocMode>('rendered');

  const summaryProvider = summary?.provider as FactoryCommunityProvider | undefined;
  const summaryOwner = summary?.owner;
  const summarySlug = summary?.slug;
  const summaryVersion = summary?.version;
  const summaryName = summary?.name;

  useEffect(() => {
    if (!summaryProvider || !summarySlug) return undefined;
    let cancelled = false;
    void fetchDesktopCommunitySkillDetail({
      provider: summaryProvider,
      owner: summaryOwner,
      slug: summarySlug,
      version: summaryVersion,
    })
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((loadError) => {
        if (!cancelled) setError(factoryErrorMessage(loadError, `Kordi could not open ${summaryName ?? summarySlug}.`));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [summaryName, summaryOwner, summaryProvider, summarySlug, summaryVersion]);

  if (!summary) {
    return (
      <main className="app-agent-studio-main">
        <div className="app-skill-library-state">
          {loadingList ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Globe2 className="h-4 w-4" />}
          <strong>{loadingList ? 'Loading skills' : 'No skill selected'}</strong>
        </div>
      </main>
    );
  }

  const provider = summary.provider as FactoryCommunityProvider;
  const providerLabel = communityProviderLabel(provider);
  const installedSkill = installedCommunityMatch(installedSkills, detail?.skill ?? summary);
  const installed = Boolean(installedSkill) || summary.installed || Boolean(detail?.skill.installed);
  const version = detail?.skill.version ?? summary.version;
  const notice = communitySecurityNotice(detail);
  const files = detail?.files ?? [];
  const activeTab = files.some((file) => file.path === tab) ? tab : OVERVIEW_TAB;
  const activeFile = files.find((file) => file.path === activeTab);
  const sourceUrl = detail?.skill.sourceUrl ?? summary.sourceUrl;

  const install = async () => {
    if (!detail || installing) return;
    setInstalling(true);
    setError(null);
    try {
      const entry = await installDesktopCommunitySkill({
        provider,
        owner: detail.skill.owner,
        slug: detail.skill.slug,
        version: detail.skill.version,
        scope: 'global',
        reviewedDigest: detail.reviewDigest,
      });
      setDetail((current) => (current ? { ...current, skill: { ...current.skill, installed: true } } : current));
      await onInstalled(summary.id, entry);
    } catch (installError) {
      setError(factoryErrorMessage(installError, `Kordi could not install ${detail.skill.name}.`));
    } finally {
      setInstalling(false);
    }
  };

  const details: Array<[string, string]> = [];
  if (summary.owner) details.push(['Publisher', summary.owner]);
  details.push(['Installs', formatInstallCount(detail?.skill.downloads ?? summary.downloads)]);
  if (version) details.push(['Version', version]);
  if (detail) details.push(['Files', String(detail.files.length)]);

  return (
    <main className="app-agent-studio-main app-factory-inspect-main">
      <FactoryDetailHeader icon={Globe2} name={detail?.skill.name ?? summary.name} meta={factoryItemMeta('Skill', providerLabel, version ? `v${version.replace(/^v/i, '')}` : null)}>
        <button
          type="button"
          className="app-button-quiet app-agent-studio-icon-button app-factory-icon-button"
          aria-label={`Open on ${providerLabel}`}
          title={`Open on ${providerLabel}`}
          onClick={() => { void openDesktopExternalUrl(sourceUrl); }}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </button>
        {installed ? (
          <>
            <span className="app-factory-installed-pill"><Check className="h-3 w-3" aria-hidden="true" />Installed</span>
            {installedSkill && onSetEnabled ? (
              <FactoryEnabledSwitch enabled={installedSkill.enabled} disabled={mutatingSkillId === installedSkill.id} onChange={(enabled) => { void onSetEnabled(installedSkill, enabled); }} />
            ) : null}
          </>
        ) : (
          <button type="button" className="app-button-quiet app-agent-studio-button is-primary is-small" disabled={!detail || installing} onClick={() => void install()}>
            {installing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {installing ? 'Installing' : 'Install'}
          </button>
        )}
      </FactoryDetailHeader>
      {error ? <ErrorLine className="mx-4 mt-3 px-2.5 py-[7px]">{error}</ErrorLine> : null}
      {files.length > 0 ? (
        <FactoryDetailTabs files={files.map((file) => file.path)} active={activeTab} onChange={setTab} docMode={docMode} onDocModeChange={setDocMode} />
      ) : null}
      <div className="app-factory-detail-body">
        {activeTab === OVERVIEW_TAB
          ? <FactoryOverview about={detail?.skill.description || summary.description} notice={notice} details={details} />
          : <FactoryFileView path={activeTab} text={activeFile?.text ?? (activeTab === 'SKILL.md' ? detail?.skillMd ?? null : null)} loading={loading} mode={docMode} />}
      </div>
    </main>
  );
}
