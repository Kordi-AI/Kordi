import { sentenceCaseAgentThreadTitle } from '@/features/chat/agentThreadTitle';
import { normalizedRelatedAgentSessionStatus, relatedAgentSessionsFromTools } from '@/features/chat/relatedAgentSessions';
import type { AgentSubsessionTask, CloudAgentSubsession, NativeAgentSubsession } from '@/features/cloud/agentSubsessionTypes';
import { subsessionTranscript } from '@/features/cloud/subsessionConversation';
import type { DesktopChatSessionDetail, Message } from '@/kordi-app/types';
import { traceMessageId, type SessionTraceMessage, type SessionTraceSubsession } from './serializeSessionTrace';

/** Background sessions nest at most this deep below the exported session. */
export const MAX_SUBSESSION_DEPTH = 4;
/** At most this many background sessions are exported with one session. */
export const MAX_SUBSESSIONS = 50;
const NATIVE_SNAPSHOT_BATCH = 8;

export type SubsessionTraceDeps = {
  /** Present on the Mac: background sessions this Mac's runtime holds. */
  native?: {
    listIds: () => Promise<string[]>;
    snapshot: (sessionId: string) => Promise<NativeAgentSubsession>;
    fetchDetail: (sessionId: string) => Promise<DesktopChatSessionDetail | null>;
  } | null;
  /** Present when the viewer is signed in: the records the app opens a background session from. */
  cloud?: {
    accountId: string;
    listTasks: (parentSessionId: string, after?: string) => Promise<{ sessions: AgentSubsessionTask[]; nextCursor: string | null }>;
    read: (sessionId: string) => Promise<CloudAgentSubsession>;
  } | null;
};

export type SubsessionTranscripts = {
  /** The complete runtime transcript of a background session this Mac holds. */
  local: (sessionId: string) => Promise<SessionTraceMessage[]>;
  /** The trace the chat view shows for a transcript. */
  present: (messages: Message[]) => SessionTraceMessage[];
};

type Candidate = {
  id: string;
  parentSessionId: string;
  parentMessageId?: string;
  parentToolId?: string;
  title?: string;
};

/** Message ids, entry ids and client ids of a transcript, each mapped to the id its line carries. */
function lineIdsByAlias(messages: readonly Message[]) {
  const ids = new Map<string, string>();
  messages.forEach((message, index) => {
    const lineId = traceMessageId(message, index);
    for (const alias of [message.id, message.entryId, message.clientMessageId]) {
      const trimmed = alias?.trim();
      if (trimmed && !ids.has(trimmed)) ids.set(trimmed, lineId);
    }
  });
  return ids;
}

/** Background sessions a transcript's tool results name, through the parser the session rows use. */
function referencedCandidates(parentSessionId: string, messages: readonly Message[]): Candidate[] {
  return messages.flatMap((message, index) => (message.turn?.tools ?? []).flatMap((tool) => (
    relatedAgentSessionsFromTools([tool]).map((session) => ({
      id: session.sessionId,
      parentSessionId,
      parentMessageId: traceMessageId(message, index),
      parentToolId: tool.id,
      title: session.title,
    }))
  )));
}

/** The Agent threads the server links to a chat. Best effort: discovery never fails the export. */
async function listedTasks(sessionId: string, cloud: SubsessionTraceDeps['cloud']) {
  const tasks: AgentSubsessionTask[] = [];
  if (!cloud) return tasks;
  const cursors = new Set<string>();
  let after: string | undefined;
  try {
    do {
      const page = await cloud.listTasks(sessionId, after);
      tasks.push(...page.sessions);
      after = page.nextCursor ?? undefined;
      if (after && cursors.has(after)) break;
      if (after) cursors.add(after);
    } while (after && tasks.length <= MAX_SUBSESSIONS);
  } catch {
    // A chat the server does not hold has no Agent threads there.
  }
  return tasks;
}

/** Background sessions this Mac's runtime holds, keyed by id. Best effort, like the sync that publishes them. */
async function nativeSnapshots(native: SubsessionTraceDeps['native']) {
  const snapshots = new Map<string, NativeAgentSubsession>();
  if (!native) return snapshots;
  const ids = await native.listIds().catch(() => [] as string[]);
  for (let start = 0; start < ids.length; start += NATIVE_SNAPSHOT_BATCH) {
    const batch = await Promise.all(ids.slice(start, start + NATIVE_SNAPSHOT_BATCH)
      .map((id) => native.snapshot(id).catch(() => null)));
    for (const snapshot of batch) if (snapshot?.sessionId) snapshots.set(snapshot.sessionId, snapshot);
  }
  return snapshots;
}

function title(...candidates: Array<string | null | undefined>) {
  const value = candidates.map((candidate) => candidate?.trim()).find(Boolean);
  return value ? sentenceCaseAgentThreadTitle(value) : 'Background session';
}

function status(value: string | null | undefined) {
  return value?.trim() ? normalizedRelatedAgentSessionStatus(value) : null;
}

/**
 * Collects the background sessions an exported session started, and the ones
 * they started in turn: those its transcript names, those this Mac's runtime
 * links to it and the Agent threads the server links to it. Each is read from
 * the copy this viewer's app can open, this Mac's runtime first, then the
 * cloud record. One the viewer cannot read is kept as unavailable instead of
 * failing the export. Depth first, parents before children, each session
 * once, at most `MAX_SUBSESSION_DEPTH` deep and `MAX_SUBSESSIONS` in all.
 */
export async function collectSubsessionTraces(
  rootSessionId: string,
  rootMessages: readonly Message[],
  deps: SubsessionTraceDeps,
  transcripts: SubsessionTranscripts,
): Promise<{ subsessions: SessionTraceSubsession[]; complete: boolean }> {
  const [native, listed] = await Promise.all([nativeSnapshots(deps.native), listedTasks(rootSessionId, deps.cloud)]);
  const listedById = new Map(listed.map((task) => [task.sessionId, task]));
  const collected: SessionTraceSubsession[] = [];
  const seen = new Set<string>([rootSessionId]);
  const skipped = new Set<string>();

  const linkedCandidates = (parentSessionId: string, messages: readonly Message[], parentRequestIds: Array<[string, string | null]>) => {
    const lineIds = lineIdsByAlias(messages);
    return parentRequestIds.map(([id, requestId]): Candidate => {
      const parentMessageId = requestId ? lineIds.get(requestId.trim()) : undefined;
      return { id, parentSessionId, ...(parentMessageId ? { parentMessageId } : {}) };
    });
  };
  const children = (parentSessionId: string, messages: readonly Message[]) => [
    ...referencedCandidates(parentSessionId, messages),
    ...linkedCandidates(parentSessionId, messages, [
      ...[...native.values()].filter((snapshot) => snapshot.parentSessionId === parentSessionId)
        .map((snapshot): [string, string | null] => [snapshot.sessionId, snapshot.parentRequestId]),
      ...listed.filter((task) => task.parentSessionId === parentSessionId)
        .map((task): [string, string | null] => [task.sessionId, task.parentRequestId]),
    ]),
  ];

  const read = async (candidate: Candidate): Promise<SessionTraceSubsession> => {
    const { id } = candidate;
    const base = {
      id,
      parentSessionId: candidate.parentSessionId,
      ...(candidate.parentMessageId ? { parentMessageId: candidate.parentMessageId } : {}),
      ...(candidate.parentToolId ? { parentToolId: candidate.parentToolId } : {}),
    };
    const snapshot = native.get(id) ?? (deps.native ? await deps.native.snapshot(id).catch(() => null) : null);
    const local = Boolean(deps.native && snapshot?.sessionId === id);
    if (local) {
      try {
        const messages = await transcripts.local(id);
        return { ...base, title: title(snapshot?.title, candidate.title), status: status(snapshot?.status), source: 'local', available: true, messages };
      } catch {
        // The cloud record is the copy the app opens a background session from.
      }
    }
    if (deps.cloud) {
      try {
        const record = await deps.cloud.read(id);
        const messages = transcripts.present(subsessionTranscript(record, deps.cloud.accountId));
        return { ...base, title: title(record.title, candidate.title), status: status(record.status), source: 'cloud', available: true, messages };
      } catch {
        // Another member's task the viewer may not read, a deleted one, or one held only on another device.
      }
    }
    const task = listedById.get(id);
    return {
      ...base,
      title: title(local ? snapshot?.title : null, task?.title, candidate.title),
      status: status(local ? snapshot?.status : task?.status),
      source: local ? 'local' : 'cloud',
      available: false,
      messages: [],
    };
  };

  const visit = async (candidate: Candidate, depth: number): Promise<void> => {
    if (seen.has(candidate.id)) return;
    if (depth > MAX_SUBSESSION_DEPTH || collected.length >= MAX_SUBSESSIONS) {
      skipped.add(candidate.id);
      return;
    }
    seen.add(candidate.id);
    const subsession = await read(candidate);
    collected.push(subsession);
    for (const child of children(subsession.id, subsession.messages)) await visit(child, depth + 1);
  };

  for (const child of children(rootSessionId, rootMessages)) await visit(child, 1);
  // Agent threads of this chat that name another parent (such as the runtime
  // session that answered a group request) still belong to it.
  for (const task of listed) {
    const [linked] = linkedCandidates(rootSessionId, rootMessages, [[task.sessionId, task.parentRequestId]]);
    await visit(linked, 1);
  }
  const truncated = [...skipped].some((id) => !seen.has(id));
  return {
    subsessions: collected,
    complete: !truncated && collected.every((subsession) => subsession.available),
  };
}
