// The Build screen's choices turned into the build request, kept free of React for tests.

import type { CgAgentFile, CgBuildRequest, CgDeviceItem, CgProfileKind, CgSourcePicks, CgUnreadLink } from './types';

export type CgBuildChoices = {
  memory: boolean;
  /** Connected connectors whose switch is on. */
  connectors: string[];
  useAgents: boolean;
  agentFiles: CgAgentFile[] | null;
  device: Array<{ source: string; items: CgDeviceItem[] }>;
  links: string;
  notes: string;
  /** Kordi documents to read (`commonGroundVersion` 3). */
  documents?: string[];
  /** The picks to save with the build; set only with `commonGroundVersion` 3. */
  picks?: CgSourcePicks;
};

export const NO_PICKS: CgSourcePicks = { memory: false, connectors: [], device: [], agents: false, documents: [], links: '', notes: '' };

/** The picks a Build screen opens with: the saved ones, or none; Rebuild on the card page turns Memory on. */
export function initialPicks(saved: CgSourcePicks | null | undefined, memory = false): CgSourcePicks {
  const picks = { ...NO_PICKS, ...saved };
  return memory ? { ...picks, memory: true } : picks;
}

export function commonGroundBuildRequest(choices: CgBuildChoices): CgBuildRequest {
  const request: CgBuildRequest = {
    memory: choices.memory,
    connectors: choices.connectors.length > 0,
    device: choices.device,
    links: choices.links,
    notes: choices.notes,
  };
  if (choices.useAgents && choices.agentFiles?.length) request.agents = choices.agentFiles.map(({ label, text }) => ({ label, text }));
  if (choices.picks) {
    request.connectorProviders = choices.connectors;
    request.documents = choices.documents ?? [];
    request.picks = choices.picks;
  }
  return request;
}

export function canBuildProfile(choices: CgBuildChoices): boolean {
  const request = commonGroundBuildRequest(choices);
  return request.memory || request.connectors || Boolean(request.agents) || request.device.length > 0
    || Boolean(choices.documents?.length) || request.links.trim().length > 0 || request.notes.trim().length > 0;
}

/** "AGENTS.md, CLAUDE.md +3", from the file names. */
export function agentFilesSummary(files: CgAgentFile[] | null): string {
  if (files === null) return 'Reading…';
  const names = files.map((file) => (file.path ?? file.label).split('/').pop() ?? file.label);
  if (!names.length) return 'No agent files found';
  const head = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${head} +${names.length - 2}` : head;
}

/** "2 chosen", or "None chosen". */
export function documentsSummary(count: number): string {
  return count ? `${count} chosen` : 'None chosen';
}

/**
 * The server found nothing to read in the sources that were on: this app never builds with
 * none on, so `common_ground_no_sources` means Memory (or another source) had nothing for the card.
 */
export function emptySourcesMessage(request: CgBuildRequest): string {
  const others = request.connectors || Boolean(request.agents?.length) || request.device.length > 0
    || Boolean(request.documents?.length) || request.links.trim().length > 0 || request.notes.trim().length > 0;
  return request.memory && !others
    ? 'Memory has nothing for this card yet. Add a note or another source.'
    : 'These sources have nothing for this card yet. Add a note or another source.';
}

/** A build that found nothing for the profile cannot succeed again with the same sources. */
export function buildFailureMessage(errorCode: string | null, unreadLinks = 0) {
  switch (errorCode) {
    case 'links_unread': return `Kordi couldn't read your ${unreadLinks > 1 ? 'links' : 'link'}, so there's nothing to build from.`;
    case 'no_topics': return 'Nothing here fits this profile. Add a note or choose other sources.';
    case 'build_timed_out': return 'Building took too long. Try again.';
    default: return 'Could not build your card. Try again.';
  }
}

/** The start request got no answer and the card shows no build: it did not start. */
export const BUILD_NOT_STARTED = 'Could not start building. Try again.';

/** Sites that show Kordi's page reader only a sign-in page, by host. */
const SIGN_IN_SITES: Record<string, string> = { 'linkedin.com': 'LinkedIn', 'facebook.com': 'Facebook', 'instagram.com': 'Instagram' };

function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** "LinkedIn" for a link to a site that needs sign-in, or null. */
export function signInSite(url: string): string | null {
  const host = linkHost(url).toLowerCase();
  const site = Object.keys(SIGN_IN_SITES).find((key) => host === key || host.endsWith(`.${key}`));
  return site ? SIGN_IN_SITES[site] : null;
}

/** The links in the Links box as the server reads them: full addresses, and bare hosts given https. */
export function linkEntries(links: string): string[] {
  return links.split(/[;\n]/).map((entry) => entry.trim()).filter(Boolean).flatMap((entry) => {
    if (entry.includes(' ')) return [];
    if (/^https?:\/\//i.test(entry)) return [entry];
    const host = entry.split('/')[0];
    const tld = host.split('.').pop() ?? '';
    return host.includes('.') && /^[a-z]{2,}$/i.test(tld) ? [`https://${entry}`] : [];
  });
}

const sameLink = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

/** The unread links still in the Links box: a link the owner removed no longer needs a line. */
export function currentUnreadLinks(unread: CgUnreadLink[], links: string): CgUnreadLink[] {
  const entries = linkEntries(links);
  return unread.filter(({ url }) => entries.some((entry) => sameLink(entry, url)));
}

/** Links in the box to a site that needs sign-in, before a build reads them. */
export function signInLinks(links: string, unread: CgUnreadLink[]): string[] {
  return linkEntries(links).filter((url) => signInSite(url) && !unread.some((link) => sameLink(link.url, url)));
}

/** Why a link was not read, in plain words: "LinkedIn needs sign-in, so Kordi can't read it." */
export function unreadLinkLine(url: string, reason?: string): string {
  const site = signInSite(url);
  const name = site ?? linkHost(url);
  // A sign-in site answers a reader that is not signed in with a wall, whatever the status says.
  switch (site && reason !== 'not_found' ? 'sign_in' : reason) {
    case 'sign_in': return `${name} needs sign-in, so Kordi can't read it.`;
    case 'blocked': return `${name} blocked Kordi from reading it.`;
    case 'not_found': return `Nothing found at ${name}.`;
    case 'unreachable': return `Couldn't reach ${name}.`;
    case 'unreadable': return `${name} has no text Kordi can read.`;
    default: return `Couldn't read ${name}`;
  }
}

/** The hint in the build screen's notes box: what this profile keeps. Work when there is no profile, as the server builds. */
export function notesHint(kind: CgProfileKind | null | undefined) {
  switch (kind) {
    case 'health': return 'How do you stay active?';
    case 'daily': return 'What do you enjoy doing?';
    case 'custom': return 'What should this profile show?';
    default: return 'What are you working on?';
  }
}
