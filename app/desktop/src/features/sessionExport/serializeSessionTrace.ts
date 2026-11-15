import { redactSensitiveToolText } from '@/features/cloud/cloudAgentExecutionTrace';
import type { DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';

export const SESSION_TRACE_SCHEMA = 'kordi.session-trace';
export const SESSION_TRACE_VERSION = 1;

export type SessionTraceParticipant = {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  role?: string | null;
  ownerId?: string | null;
};

export type SessionTraceMessage = Message & {
  /** Model attribution recovered from the source row, when the transcript row keeps none. */
  traceModel?: { provider: string; model: string } | null;
};

/** A background session an agent started from the exported session, or from another background session. */
export type SessionTraceSubsession = {
  id: string;
  parentSessionId: string;
  /** The parent message that started it, when that message is in the file. */
  parentMessageId?: string | null;
  /** The parent tool call that started it. */
  parentToolId?: string | null;
  title: string;
  status?: string | null;
  source: 'local' | 'cloud';
  /** False when this viewer's app could not read it; it then carries no messages. */
  available: boolean;
  messages: readonly SessionTraceMessage[];
};

export type SessionTraceInput = {
  exportedAt: Date;
  appVersion?: string | null;
  session: {
    id: string;
    kind: string;
    title: string;
    createdAtMs?: number | null;
    project?: string | null;
  };
  participants: readonly SessionTraceParticipant[];
  /** Account or identity id of the viewer who exports the trace. */
  exportedBy: string;
  /** Identity used for the viewer's own messages when a row names none. */
  viewerIdentityId?: string | null;
  messages: readonly SessionTraceMessage[];
  /** Background sessions in file order: depth first, each parent before its children. */
  subsessions?: readonly SessionTraceSubsession[];
  complete: boolean;
};

export type TraceSender = { id: string; name: string; kind: 'human' | 'agent' | 'system' };

function rfc3339(ms: number) {
  return new Date(ms).toISOString();
}

function finiteMs(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: string | null | undefined) {
  return typeof value === 'string' ? value : '';
}

function nonEmpty(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function senderKind(message: Message): TraceSender['kind'] {
  if (message.role === 'system' || message.role === 'action' || message.role === 'edit') return 'system';
  if (message.senderType === 'agent' || message.role === 'owned-agent' || message.role === 'external-agent') return 'agent';
  return 'human';
}

function traceRole(kind: TraceSender['kind']) {
  return kind === 'agent' ? 'assistant' : kind === 'system' ? 'system' : 'user';
}

export function traceMessageSender(
  message: Message,
  input: Pick<SessionTraceInput, 'exportedBy' | 'viewerIdentityId'>,
): TraceSender {
  const kind = senderKind(message);
  const name = nonEmpty(message.sourceSenderLabel) ?? nonEmpty(message.sender)
    ?? (kind === 'system' ? 'System' : kind === 'agent' ? 'Agent' : 'Unknown');
  const ownMessage = message.isOwnMessage === true || message.role === 'user';
  const id = nonEmpty(message.senderIdentityId)
    ?? (kind === 'system' ? 'system' : null)
    ?? (ownMessage && kind === 'human' ? nonEmpty(input.viewerIdentityId) ?? nonEmpty(input.exportedBy) : null)
    ?? `${kind}:${name.toLowerCase()}`;
  return { id, name, kind };
}

function traceAttachments(message: Message) {
  const attachments = (message.attachments ?? []).flatMap((attachment) => {
    const name = nonEmpty(attachment.name);
    if (!name) return [];
    const mime = nonEmpty(attachment.mimeType);
    const size = finiteMs(attachment.sizeBytes);
    // Metadata only: never file bytes, preview data or local paths.
    return [{ name, ...(mime ? { mime } : {}), ...(size !== null ? { size } : {}) }];
  });
  return attachments.length ? attachments : null;
}

function traceSegments(turn: DesktopChatTurnSnapshot) {
  const segments = (turn.segments ?? []).map((segment) => (
    segment.kind === 'text'
      ? { id: segment.id, kind: 'text' as const, text: segment.text }
      : { id: segment.id, kind: 'tool' as const, tool_id: segment.toolId }
  ));
  return segments.length ? segments : null;
}

function traceTools(turn: DesktopChatTurnSnapshot) {
  return (turn.tools ?? []).map((tool) => ({
    id: tool.id,
    name: tool.name,
    status: tool.status,
    arguments: redactSensitiveToolText(text(tool.arguments)),
    result: redactSensitiveToolText(text(tool.resultText) || text(tool.liveOutput)),
    is_error: tool.isError === true,
  }));
}

/** Provider and model of a local runtime turn, as the runtime labels it ("provider/model • state"). */
export function runtimeTurnModel(detail: string | null | undefined) {
  const match = /^([^/\s•]+)\/([^\s•]+)\s+•/.exec(detail?.trim() ?? '');
  return match ? { provider: match[1], model: match[2] } : null;
}

function traceAgentTurn(turn: DesktopChatTurnSnapshot, model: { provider: string; model: string } | null) {
  const startedAt = finiteMs(turn.startedAtMs);
  const completedAt = finiteMs(turn.completedAtMs);
  const thinking = text(turn.thinkingText).trim() ? redactSensitiveToolText(turn.thinkingText) : null;
  const segments = traceSegments(turn);
  const error = nonEmpty(turn.error);
  return {
    status: turn.status,
    ...(model ? { model: model.model, provider: model.provider } : {}),
    ...(startedAt !== null ? { started_at: rfc3339(startedAt) } : {}),
    ...(completedAt !== null ? { completed_at: rfc3339(completedAt) } : {}),
    ...(thinking ? { thinking } : {}),
    ...(segments ? { segments } : {}),
    tools: traceTools(turn),
    ...(error ? { error } : {}),
  };
}

/** The id a message line carries; background session lines name their parent message by it. */
export function traceMessageId(message: Message, index: number) {
  return nonEmpty(message.id) ?? nonEmpty(message.entryId) ?? `message-${index + 1}`;
}

function firstTimestampMs(messages: readonly Message[]) {
  return messages.map((message) => finiteMs(message.timestampMs)).find((value) => value !== null) ?? null;
}

/** One session's message lines, `seq` from 1, with a monotonic fallback timestamp. */
function messageLines(
  sessionId: string,
  messages: readonly SessionTraceMessage[],
  startMs: number,
  input: Pick<SessionTraceInput, 'exportedBy' | 'viewerIdentityId'>,
) {
  let previousMs = startMs;
  return messages.map((message, index) => {
    const timestampMs = finiteMs(message.timestampMs)
      ?? finiteMs(message.turn?.startedAtMs)
      ?? finiteMs(message.turn?.completedAtMs)
      ?? previousMs;
    previousMs = timestampMs;
    const sender = traceMessageSender(message, input);
    const kind = nonEmpty(message.messageKind) ?? (message.voiceMessage ? 'voice' : null);
    const replyTo = nonEmpty(message.replyToMessageId);
    const attachments = traceAttachments(message);
    const turn = message.turn;
    return {
      type: 'message',
      session_id: sessionId,
      id: traceMessageId(message, index),
      seq: index + 1,
      timestamp: rfc3339(timestampMs),
      sender,
      role: traceRole(sender.kind),
      ...(kind ? { kind } : {}),
      text: text(message.text) || text(turn?.assistantText),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(attachments ? { attachments } : {}),
      ...(turn ? { agent_turn: traceAgentTurn(turn, message.traceModel ?? null) } : {}),
    };
  });
}

function subsessionLines(
  subsession: SessionTraceSubsession,
  fallbackStartMs: number,
  input: Pick<SessionTraceInput, 'exportedBy' | 'viewerIdentityId'>,
) {
  const messages = subsession.available ? subsession.messages : [];
  const parentMessageId = nonEmpty(subsession.parentMessageId);
  const parentToolId = nonEmpty(subsession.parentToolId);
  const status = nonEmpty(subsession.status);
  return [{
    type: 'subsession',
    id: subsession.id,
    parent_session_id: subsession.parentSessionId,
    ...(parentMessageId ? { parent_message_id: parentMessageId } : {}),
    ...(parentToolId ? { parent_tool_id: parentToolId } : {}),
    title: subsession.title,
    ...(status ? { status } : {}),
    source: subsession.source,
    available: subsession.available,
    message_count: messages.length,
  }, ...messageLines(subsession.id, messages, firstTimestampMs(messages) ?? fallbackStartMs, input)];
}

/** Builds the JSON Lines text of a session trace. Pure: performs no I/O. */
export function serializeSessionTrace(input: SessionTraceInput): string {
  const exportedAtMs = input.exportedAt.getTime();
  const subsessions = input.subsessions ?? [];
  const createdAtMs = finiteMs(input.session.createdAtMs) ?? firstTimestampMs(input.messages);
  const appVersion = nonEmpty(input.appVersion);
  const project = nonEmpty(input.session.project);
  const header = {
    type: 'session',
    schema: SESSION_TRACE_SCHEMA,
    version: SESSION_TRACE_VERSION,
    exported_at: rfc3339(exportedAtMs),
    ...(appVersion ? { app_version: appVersion } : {}),
    session: {
      id: input.session.id,
      kind: input.session.kind,
      title: input.session.title,
      ...(createdAtMs !== null ? { created_at: rfc3339(createdAtMs) } : {}),
      ...(project ? { project } : {}),
    },
    participants: input.participants.map((participant) => {
      const role = nonEmpty(participant.role);
      const ownerId = nonEmpty(participant.ownerId);
      return {
        id: participant.id,
        name: participant.name,
        kind: participant.kind,
        ...(role ? { role } : {}),
        ...(ownerId ? { owner_id: ownerId } : {}),
      };
    }),
    exported_by: input.exportedBy,
    message_count: input.messages.length,
    subsession_count: subsessions.length,
    complete: input.complete,
  };
  const startMs = createdAtMs ?? exportedAtMs;
  const lines = [
    header,
    ...messageLines(input.session.id, input.messages, startMs, input),
    ...subsessions.flatMap((subsession) => subsessionLines(subsession, startMs, input)),
  ];
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

/** `kordi-trace-<slug-of-title>-<YYYYMMDD-HHmm>.jsonl`, in the viewer's local time. */
export function sessionTraceFileName(title: string, at: Date) {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') || 'session';
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `kordi-trace-${slug}-${stamp}.jsonl`;
}
