// Community skill catalogs (ClawHub, skills.sh): browse, search, review and install.
import { invokeDesktop } from './desktopInvoke';
import { isNativeDesktopShell, type DesktopSkillLibraryEntry } from './desktop';

export type DesktopCommunitySkillProvider = 'clawhub' | 'skills-sh';

export type DesktopCommunitySkillSummary = {
  id: string;
  provider: string;
  owner?: string | null;
  slug: string;
  name: string;
  description: string;
  version?: string | null;
  downloads: number;
  stars: number;
  updatedAtMs?: number | null;
  sourceUrl: string;
  installed: boolean;
};

export type DesktopCommunitySkillFile = {
  path: string;
  size: number;
  sha256?: string | null;
  contentType?: string | null;
  text?: string | null;
};

export type DesktopCommunitySkillDetail = {
  skill: DesktopCommunitySkillSummary;
  files: DesktopCommunitySkillFile[];
  skillMd: string;
  securityStatus: string;
  securitySummary: string;
  digest?: string | null;
  reviewDigest: string;
};

export async function searchDesktopCommunitySkills(
  provider: DesktopCommunitySkillProvider,
  query: string,
) {
  if (!isNativeDesktopShell()) return [] as DesktopCommunitySkillSummary[];
  return invokeDesktop<DesktopCommunitySkillSummary[]>('desktop_skill_community_search', { provider, query });
}

/** The catalog's most-installed skills, shown before the user types a search. */
export async function fetchDesktopCommunityPopularSkills(provider: DesktopCommunitySkillProvider) {
  if (!isNativeDesktopShell()) return [] as DesktopCommunitySkillSummary[];
  return invokeDesktop<DesktopCommunitySkillSummary[]>('desktop_skill_community_popular', { provider });
}

export async function fetchDesktopCommunitySkillProviders() {
  if (!isNativeDesktopShell()) return ['clawhub'] as Array<DesktopCommunitySkillProvider>;
  return invokeDesktop<Array<DesktopCommunitySkillProvider>>('desktop_skill_community_providers');
}

export async function fetchDesktopCommunitySkillDetail(input: {
  provider: DesktopCommunitySkillProvider;
  owner?: string | null;
  slug: string;
  version?: string | null;
}) {
  return invokeDesktop<DesktopCommunitySkillDetail>('desktop_skill_community_detail', input);
}

export async function installDesktopCommunitySkill(input: {
  provider: DesktopCommunitySkillProvider;
  owner?: string | null;
  slug: string;
  version?: string | null;
  scope: 'global' | 'project';
  reviewedDigest: string;
}) {
  return invokeDesktop<DesktopSkillLibraryEntry>('desktop_skill_community_install', input);
}
