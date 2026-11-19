import { useSyncExternalStore } from 'react';
import { CloudAuthClient } from '@/features/cloud/authClient';
import { cloudApiBaseUrl } from '@/features/cloud/cloudApiEnvironment';
import { cloudFetchImpl } from '@/features/cloud/cloudTransport';
import { CLOUD_SESSION_CHANGED_EVENT, CLOUD_SESSION_SIGNED_OUT_EVENT, loadSession } from '@/features/cloud/session';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import { isPersonalAgentSession } from '@/features/personalAgent/personalAgentStore';
import type { Conversation } from '@/kordi-app/types';

/** A project folder one Mac publishes; the ID is an opaque hash of its path on that Mac. */
export type BrowserProject = { id: string; name: string; sessions: string[] };
export type BrowserProjectDevice = { id: string; name: string; online: boolean; projects: BrowserProject[] };
/** One project folder across the Macs that publish it, online Macs first. */
export type BrowserProjectGroup = { project: BrowserProject; devices: BrowserProjectDevice[] };

export type BrowserProjectCatalog = {
  devices: BrowserProjectDevice[];
  groups: BrowserProjectGroup[];
  loaded: boolean;
  error: string | null;
};

const PROJECT_ID = /^[a-f0-9]{64}$/u;
const REFRESH_MS = 30_000;
const POLL_MS = 1_000;
const MAX_POLLS = 720;
/** A Mac picks up a queued action only within two minutes; after that it never runs. */
const QUEUED_LIMIT_MS = 130_000;
const EMPTY: BrowserProjectCatalog = { devices: [], groups: [], loaded: false, error: null };

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Reads the account catalog, dropping malformed entries. Every device is a Mac; the browser never publishes. */
export function parseProjectCatalog(value: unknown): BrowserProjectDevice[] {
  const devices = (value as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(devices)) return [];
  return devices.flatMap((device: Record<string, unknown> | null) => {
    const id = text(device?.id);
    if (!id || !Array.isArray(device?.projects)) return [];
    const projects = (device.projects as Record<string, unknown>[]).flatMap((project) => {
      const projectId = text(project?.id);
      const name = text(project?.name);
      if (!PROJECT_ID.test(projectId) || !name || !Array.isArray(project.sessions)) return [];
      const sessions = [...new Set((project.sessions as unknown[]).map(text).filter(Boolean))];
      return [{ id: projectId, name, sessions }];
    });
    return [{ id, name: text(device.name) || 'Mac', online: device.online === true, projects }];
  });
}

/** Merges the same folder across Macs by ID, never by name, and lists online Macs first. */
export function mergeProjectGroups(devices: readonly BrowserProjectDevice[]): BrowserProjectGroup[] {
  const groups = new Map<string, BrowserProjectGroup>();
  for (const device of devices) {
    for (const project of device.projects) {
      const group = groups.get(project.id);
      if (!group) {
        groups.set(project.id, { project: { ...project, sessions: [...project.sessions] }, devices: [device] });
        continue;
      }
      const sessions = [...new Set([...group.project.sessions, ...project.sessions])];
      // An online Mac's name for the folder wins over an offline one.
      const name = device.online && !group.devices.some((entry) => entry.online) ? project.name : group.project.name;
      group.project = { id: project.id, name, sessions };
      group.devices.push(device);
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    devices: [...group.devices.filter((device) => device.online), ...group.devices.filter((device) => !device.online)],
  }));
}

/** Macs for the picker: each project once, under an online Mac that publishes it when there is one. */
export function projectPickerDevices(devices: readonly BrowserProjectDevice[]): BrowserProjectDevice[] {
  const groups = new Map(mergeProjectGroups(devices).map((group) => [group.project.id, group]));
  return devices.flatMap((device) => {
    const projects = device.projects.flatMap((project) => {
      const group = groups.get(project.id);
      return group?.devices[0]?.id === device.id ? [group.project] : [];
    });
    return projects.length ? [{ ...device, projects }] : [];
  });
}

/** The project that lists a session, merged across Macs. */
export function projectGroupForSession(groups: readonly BrowserProjectGroup[], sessionId: string) {
  return groups.find((group) => group.project.sessions.includes(sessionId)) ?? null;
}

/** The Mac that holds a session's project, an online one first. */
export function projectDeviceForSession(devices: readonly BrowserProjectDevice[], sessionId: string) {
  const holders = devices.filter((device) => device.projects.some((project) => project.sessions.includes(sessionId)));
  return holders.find((device) => device.online) ?? holders[0] ?? null;
}

export function chatProjectSessionId(conversation: Pick<Conversation, 'id' | 'canonicalSessionId'>) {
  return (conversation.canonicalSessionId ?? conversation.id).trim();
}

/** Only the owner's own agent sessions move between projects: never sub-sessions, personal agents or shared chats. */
export function canChooseBrowserProject(conversation: Conversation) {
  const sessionId = chatProjectSessionId(conversation);
  return conversation.type === 'owned-agent' && !conversation.agentSubsessionId && !conversation.collaborationTarget
    && !conversation.transientDraft && !isLocalDraftChatConversationId(conversation.id)
    && Boolean(sessionId) && !isPersonalAgentSession(sessionId, conversation.metadata);
}

export type BrowserProjectPicker = {
  /** The Mac that can take the session out of its project; null when it is in none. */
  noProjectDeviceId: string | null;
  sections: { device: BrowserProjectDevice; options: { project: BrowserProject; selected: boolean; disabled: boolean }[] }[];
  /** False when no Mac publishes a project. */
  hasProjects: boolean;
};

/** What the picker offers for a session: offline Macs' projects stay listed but cannot be chosen. */
export function browserProjectPicker(devices: readonly BrowserProjectDevice[], sessionId: string, query = ''): BrowserProjectPicker {
  const needle = query.trim().toLocaleLowerCase();
  const pickerDevices = projectPickerDevices(devices);
  return {
    noProjectDeviceId: projectDeviceForSession(devices, sessionId)?.id ?? null,
    sections: pickerDevices.map((device) => ({
      device,
      options: device.projects
        .filter((project) => !needle || project.name.toLocaleLowerCase().includes(needle))
        .map((project) => ({ project, selected: project.sessions.includes(sessionId), disabled: !device.online })),
    })).filter((section) => section.options.length > 0),
    hasProjects: pickerDevices.length > 0,
  };
}

export type BrowserProjectRequest =(path: string, method?: string, body?: unknown) => Promise<unknown>;

async function responseMessage(response: Response) {
  try {
    const body = await response.json() as { message?: unknown };
    return text(body?.message);
  } catch {
    return '';
  }
}

/** Calls the account's project API with the browser's cookie session. */
export const browserProjectRequest: BrowserProjectRequest = async (path, method = 'GET', body) => {
  const session = await loadSession();
  if (!session) throw new Error('Sign in to Kordi to continue.');
  const response = await cloudFetchImpl()(`${cloudApiBaseUrl()}/v1/cloud/projects${path}`, {
    method, headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(await responseMessage(response) || 'Projects are unavailable. Try again.');
  return response.json();
};

export type AssignBrowserProjectInput = { deviceId: string; projectId: string | null; sessionId: string };
export type AssignBrowserProjectDependencies = {
  request?: BrowserProjectRequest;
  /** Creates the session's server conversation when it has none, so the Mac can verify ownership. */
  prepareConversation?: (sessionId: string) => Promise<void>;
  commandId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

async function prepareProjectConversation(sessionId: string) {
  const session = await loadSession();
  if (!session) throw new Error('Sign in to Kordi to continue.');
  await new CloudAuthClient().ensureChatConversation(session.token, {
    accountId: session.accountId, peerAccountId: session.accountId, sessionId, kind: 'ai', memberAccountIds: [session.accountId],
  });
}

/**
 * Asks the Mac that publishes the project to move the session into it, or out of
 * its project when no project is given, and waits for that Mac to finish. The
 * command ID stays the same through polling, so an action is never sent twice.
 */
export async function assignBrowserProject(input: AssignBrowserProjectInput, dependencies: AssignBrowserProjectDependencies = {}) {
  const request = dependencies.request ?? browserProjectRequest;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const now = dependencies.now ?? Date.now;
  await (dependencies.prepareConversation ?? prepareProjectConversation)(input.sessionId);
  const commandId = dependencies.commandId?.() ?? crypto.randomUUID();
  await request('/commands', 'POST', {
    commandId, deviceId: input.deviceId, action: 'assign', sessionId: input.sessionId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  });
  const started = now();
  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    await sleep(POLL_MS);
    const command = await request(`/commands/${encodeURIComponent(commandId)}`) as { status?: unknown; result?: { message?: unknown } | null };
    if (command?.status === 'completed') return;
    if (command?.status === 'failed') throw new Error(text(command.result?.message) || 'The change could not finish. Check Kordi on your Mac.');
    if (command?.status === 'queued' && now() - started > QUEUED_LIMIT_MS) {
      throw new Error('Your Mac did not respond. Open Kordi on your Mac and try again.');
    }
  }
  throw new Error('The change timed out. Check Kordi on your Mac before trying again.');
}

// One catalog per page, shared by the sidebar and every composer, polled only while shown.
let catalog = EMPTY;
let generation = 0;
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let eventsInstalled = false;
let catalogRequest: BrowserProjectRequest = browserProjectRequest;
const listeners = new Set<() => void>();

export function __setBrowserProjectRequestForTests(next: BrowserProjectRequest) { catalogRequest = next; }

function publish(next: BrowserProjectCatalog) {
  catalog = next;
  for (const listener of listeners) listener();
}

/** Loads the account catalog again; a response for a previous account or workspace is dropped. */
export async function refreshBrowserProjects(load: BrowserProjectRequest = catalogRequest) {
  const started = ++generation;
  try {
    const devices = parseProjectCatalog(await load(''));
    if (started !== generation) return;
    const next = { devices, groups: mergeProjectGroups(devices), loaded: true, error: null };
    if (JSON.stringify(next) !== JSON.stringify(catalog)) publish(next);
  } catch (error) {
    if (started !== generation) return;
    publish({ ...catalog, loaded: true, error: error instanceof Error ? error.message : 'Projects are unavailable. Try again.' });
  }
}

/** Another account or workspace never sees the previous one's projects. */
export function resetBrowserProjects() {
  generation += 1;
  publish(EMPTY);
  if (subscribers > 0) void refreshBrowserProjects();
}

export function subscribeBrowserProjects(listener: () => void) {
  listeners.add(listener);
  subscribers += 1;
  if (!eventsInstalled && typeof window !== 'undefined') {
    eventsInstalled = true;
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, resetBrowserProjects);
    window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, resetBrowserProjects);
  }
  if (subscribers === 1) {
    void refreshBrowserProjects();
    timer = setInterval(() => { void refreshBrowserProjects(); }, REFRESH_MS);
  }
  return () => {
    listeners.delete(listener);
    subscribers -= 1;
    if (subscribers === 0 && timer) { clearInterval(timer); timer = null; }
  };
}

export function browserProjectCatalogSnapshot() {
  return catalog;
}

/** The account's project catalog; empty and idle when not enabled. */
export function useBrowserProjectCatalog(enabled: boolean) {
  return useSyncExternalStore(enabled ? subscribeBrowserProjects : subscribeNothing, enabled ? browserProjectCatalogSnapshot : emptySnapshot, emptySnapshot);
}

function subscribeNothing() { return () => undefined; }
function emptySnapshot() { return EMPTY; }
