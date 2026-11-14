import type { DesktopCommunitySkillDetail, DesktopCommunitySkillSummary, DesktopSkillLibraryEntry } from '@/lib/desktop';
import { communityProviderLabel, type FactoryLibrarySection } from './model';

/** The detail tab id for Overview; file tabs use the file path. */
export const OVERVIEW_TAB = '';

const KIND_LABELS = { skill: 'Skills', tool: 'Tools', plugin: 'Plugins' } satisfies Record<FactoryLibrarySection, string>;

export function libraryKindLabel(kind: FactoryLibrarySection) {
  return KIND_LABELS[kind];
}

export function factoryErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export function formatInstallCount(value: number) {
  return new Intl.NumberFormat('en', { notation: value >= 1_000 ? 'compact' : 'standard' }).format(value);
}

/** Where an installed skill came from, in words a person recognizes. */
export function skillSource(skill: DesktopSkillLibraryEntry) {
  if (skill.provider?.trim()) return communityProviderLabel(skill.provider.trim());
  if (skill.origin === 'built') return 'Kordi Factory';
  if (skill.origin === 'project' || skill.scope === 'project') return 'This project';
  if (skill.origin === 'community') return 'Community';
  if (skill.scope === 'package') return 'Installed package';
  if (['installed', 'external'].includes(skill.origin) || ['global', 'shared', 'external'].includes(skill.scope)) return 'Local library';
  return skill.sourceLabel.replace(/^settings:/i, '') || 'Local library';
}

export function installedCommunityMatch(skills: DesktopSkillLibraryEntry[], result?: DesktopCommunitySkillSummary | null) {
  if (!result) return null;
  return skills.find((skill) => (
    skill.provider === result.provider
      && skill.owner === result.owner
      && (skill.sourceUrl === result.sourceUrl || skill.name === result.slug)
  )) ?? null;
}

/** The skill folder, for Copy path; `sourcePath` points at its SKILL.md. */
export function skillFolderPath(skill: DesktopSkillLibraryEntry) {
  return skill.sourcePath.replace(/[\\/]SKILL\.md$/i, '');
}

/** "Skill · source · version", leaving out parts that are unknown. */
export function factoryItemMeta(kind: string, ...parts: Array<string | null | undefined>) {
  return [kind, ...parts.map((part) => part?.trim()).filter(Boolean)].join(' · ');
}

/** Scan results that need no warning. "unreviewed" means no scan ran, not that one flagged something. */
const QUIET_SECURITY_STATUSES = new Set(['clean', 'pass', 'unreviewed']);

export function communitySecurityNotice(detail: Pick<DesktopCommunitySkillDetail, 'securityStatus' | 'securitySummary'> | null) {
  if (!detail || QUIET_SECURITY_STATUSES.has(detail.securityStatus.trim().toLowerCase())) return null;
  return detail.securitySummary.trim() || 'The security scan flagged this skill. Review every file before installing.';
}

export function isMarkdownPath(path: string) {
  return /\.(md|markdown|mdx)$/i.test(path);
}

/** Splits leading YAML front matter into simple key and value pairs for display. */
export function splitFrontMatter(source: string) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { fields: [] as Array<[string, string]>, body: source };
  const fields: Array<[string, string]> = [];
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field) fields.push([field[1], field[2].replace(/^["']|["']$/g, '')]);
    else if (fields.length > 0 && line.trim()) {
      const last = fields[fields.length - 1];
      last[1] = [last[1].replace(/^[>|]-?$/, ''), line.trim()].filter(Boolean).join(' ');
    }
  }
  return { fields, body: source.slice(match[0].length) };
}
