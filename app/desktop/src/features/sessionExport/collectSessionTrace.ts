import { presentLocalAgentMessages } from '@/features/canonical/readModel/localAgentPresentation';
import { dedupeRepeatedFailedAgentTurns } from '@/features/canonical/repeatedFailedAgentTurns';
import { createCanonicalSessionReadModel } from '@/features/canonical/sessionReadModel';
import { mapDesktopMessagesForTranscript } from '@/features/chat/useDesktopTranscriptAdapter';
import { cloudAgentPublicBackgroundToolsFromTurn } from '@/features/cloud/cloudAgentBackgroundSessions';
import type {
  CanonicalMessagePage,
  CanonicalSessionMessage,
  CanonicalSessionState,
  CanonicalTimelineCursor,
  DesktopChatSessionDetail,
  Message,
} from '@/kordi-app/types';
import { completeCloudTranscript, type CloudSessionTraceDeps } from './cloudSessionTrace';
import { collectSubsessionTraces, type SubsessionTraceDeps } from './collectSubsessionTraces';
import { runtimeTurnModel, type SessionTraceMessage, type SessionTraceSubsession } from './serializeSessionTrace';

export const CANONICAL_TRACE_PAGE_SIZE = 200;

export type SessionTraceSource = 'runtime' | 'canonical' | 'cloud';

export type CollectSessionTraceDeps = {
  /** Present only for a session the local agent runtime owns on this Mac. */
  runtime?: {
    fetchDetail: (sessionId: string) => Promise<DesktopChatSessionDetail | null>;
    metadata?: unknown;
  } | null;
  canonical: {
    state: CanonicalSessionState | null;
    fetchPage: (
      sessionId: string,
      before: CanonicalTimelineCursor | null,
      limit: number,
    ) => Promise<CanonicalMessagePage | null>;
  };
  /** Present only for a conversation the server holds. */
  cloud?: CloudSessionTraceDeps | null;
  /** Where the background sessions the session started are found and read. */
  subsessions?: SubsessionTraceDeps | null;
  localAgentLabel?: string | null;
};

export type CollectedSessionTrace = {
  source: SessionTraceSource;
  messages: SessionTraceMessage[];
  subsessions: SessionTraceSubsession[];
  complete: boolean;
};

function compareTimeline(left: CanonicalTimelineCursor, right: CanonicalTimelineCursor) {
  return left.createdAtMs - right.createdAtMs || left.sequenceNum - right.sequenceNum || left.id.localeCompare(right.id);
}

/** Reads every page of a canonical session in timeline order, oldest message first. */
export async function collectCanonicalRows(
  sessionId: string,
  fetchPage: CollectSessionTraceDeps['canonical']['fetchPage'],
): Promise<CanonicalSessionMessage[]> {
  const pages: CanonicalSessionMessage[][] = [];
  const seen = new Set<string>();
  let before: CanonicalTimelineCursor | null = null;
  for (;;) {
    const page = await fetchPage(sessionId, before, CANONICAL_TRACE_PAGE_SIZE);
    if (!page) throw new Error('Session history is unavailable.');
    pages.unshift(page.messages.filter((row) => !seen.has(row.id)));
    page.messages.forEach((row) => seen.add(row.id));
    if (!page.hasOlder) break;
    const first = page.messages[0];
    const next = first ? { id: first.id, createdAtMs: first.createdAtMs, sequenceNum: first.sequenceNum } : null;
    if (!next || (before && compareTimeline(next, before) >= 0)) {
      throw new Error('Session history did not advance its cursor.');
    }
    before = next;
  }
  return pages.flat();
}

/** The session's transcript as the chat view renders it, built from its complete canonical history. */
function canonicalTranscript(
  sessionId: string,
  state: CanonicalSessionState,
  rows: CanonicalSessionMessage[],
  localAgentLabel: string | null | undefined,
): Message[] {
  const sessionState: CanonicalSessionState = {
    ...state,
    sessions: state.sessions.filter((session) => session.id === sessionId),
    participants: state.participants.filter((participant) => participant.sessionId === sessionId),
    messages: rows,
    delegatedExchanges: state.delegatedExchanges.filter((exchange) => exchange.sessionId === sessionId),
    presence: [],
    contextSnapshots: [],
  };
  return createCanonicalSessionReadModel(sessionState, { localAgentDisplayName: localAgentLabel })
    ?.messages(sessionId) ?? [];
}

/**
 * The trace the chat view shows: only the viewer's own agent shows its
 * reasoning and tool calls; any other agent keeps only its public background
 * session links, as the transcript renders it.
 */
function visibleTrace(messages: Message[]): Message[] {
  return messages.map((message) => (
    message.turn && message.role !== 'owned-agent'
      ? { ...message, turn: { ...message.turn, thinkingText: '', segments: undefined, tools: cloudAgentPublicBackgroundToolsFromTurn(message.turn) } }
      : message
  ));
}

async function runtimeTranscript(
  sessionId: string,
  runtime: NonNullable<CollectSessionTraceDeps['runtime']>,
): Promise<SessionTraceMessage[]> {
  const detail = await runtime.fetchDetail(sessionId);
  if (!detail || detail.id !== sessionId) throw new Error('Session history is unavailable.');
  const modelByEntryId = new Map(detail.messages.flatMap((message) => {
    const model = message.role === 'assistant' ? runtimeTurnModel(message.detail) : null;
    const entryId = message.entryId?.trim();
    return model && entryId ? [[entryId, model] as const] : [];
  }));
  return mapDesktopMessagesForTranscript(sessionId, detail.messages, undefined, { metadata: runtime.metadata })
    .map((message) => {
      const traceModel = message.turn && message.entryId ? modelByEntryId.get(message.entryId) : undefined;
      return traceModel ? { ...message, traceModel } : message;
    });
}

/** The main session's messages and where they came from. Any read error rejects. */
async function collectMainMessages(
  sessionId: string,
  deps: CollectSessionTraceDeps,
): Promise<{ source: SessionTraceSource; messages: Message[] }> {
  if (deps.runtime) return { source: 'runtime', messages: await runtimeTranscript(sessionId, deps.runtime) };
  const state = deps.canonical.state;
  if (!state) throw new Error('Session history is unavailable.');
  const rows = await collectCanonicalRows(sessionId, deps.canonical.fetchPage);
  const rendered = canonicalTranscript(sessionId, state, rows, deps.localAgentLabel);
  const completed = deps.cloud
    ? await completeCloudTranscript(sessionId, rendered, deps.cloud, deps.localAgentLabel?.trim() || 'My agent')
    : null;
  return { source: completed ? 'cloud' : 'canonical', messages: completed ?? rendered };
}

/**
 * Collects a session's complete history, independent of what the chat view
 * has loaded. A local runtime session reads the runtime transcript; any other
 * session reads all canonical pages, and a server conversation is completed
 * from every server page. Any read error of the session itself rejects. The
 * background sessions it started follow; one the viewer cannot read is kept
 * as unavailable and makes the trace incomplete.
 */
export async function collectSessionTrace(
  sessionId: string,
  deps: CollectSessionTraceDeps,
): Promise<CollectedSessionTrace> {
  const present = (messages: Message[]) => visibleTrace(presentLocalAgentMessages(
    dedupeRepeatedFailedAgentTurns(messages),
    deps.localAgentLabel,
  ));
  const main = await collectMainMessages(sessionId, deps);
  const messages = present(main.messages);
  const native = deps.subsessions?.native;
  const background = deps.subsessions
    ? await collectSubsessionTraces(sessionId, messages, deps.subsessions, {
      local: async (id) => {
        if (!native) throw new Error('Session history is unavailable.');
        return present(await runtimeTranscript(id, { fetchDetail: native.fetchDetail }));
      },
      present,
    })
    : { subsessions: [], complete: true };
  return { source: main.source, messages, subsessions: background.subsessions, complete: background.complete };
}
