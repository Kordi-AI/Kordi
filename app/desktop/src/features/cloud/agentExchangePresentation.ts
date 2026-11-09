import type { DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { isAgentExchangeControlText } from './agentExchangeOutcome';

export type AgentExchangeStatus = 'waiting' | 'processing' | 'completed' | 'failed' | 'cancelled';
export function agentExchangeStatus(value: unknown): AgentExchangeStatus | undefined {
  return ['waiting', 'processing', 'completed', 'failed', 'cancelled'].includes(String(value)) ? value as AgentExchangeStatus : undefined;
}

/** Ordered text can arrive before assistantText, and survive a live/history merge. */
export function publicAgentExchangeTurn(turn: DesktopChatTurnSnapshot): DesktopChatTurnSnapshot {
  const internal = (text: string) => isAgentExchangeControlText(text ?? '', !turn.completed);
  return {
    ...turn,
    assistantText: internal(turn.assistantText) ? '' : turn.assistantText,
    message: internal(turn.message) ? '' : turn.message,
    segments: turn.segments?.filter(segment => segment.kind !== 'text' || !internal(segment.text)),
  };
}

/** Who a question to a person waits for; absent for a question to an agent. */
export function agentExchangeWaitingFor(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : undefined;
}

/**
 * Whether a question waits for the viewer: the server names the account it
 * waits for, and marks a question the owner's agent asked the owner, as the
 * requester (`ownAgentAskedOwner`), which older servers send alone.
 */
export function agentExchangeWaitsForViewer(waitingForAccountId: unknown, viewerAccountId: string | null | undefined, ownAgentAskedOwner: boolean): boolean {
  const waiting = typeof waitingForAccountId === 'string' ? waitingForAccountId.trim() : '';
  const viewer = viewerAccountId?.trim() ?? '';
  return ownAgentAskedOwner || (Boolean(waiting) && waiting === viewer);
}

/**
 * The durable question owns one progress indicator through reply and continuation.
 * `forViewer` marks a question that waits for the viewer's own answer.
 */
export function agentExchangeProgressTurn(
  state: unknown, text: string, id: string, sessionId: string,
  turn?: DesktopChatTurnSnapshot | null, waitingFor?: unknown, forViewer = false,
): DesktopChatTurnSnapshot | null {
  const status = agentExchangeStatus(state);
  if (status !== 'waiting' && status !== 'processing') return turn ?? null;
  const person = agentExchangeWaitingFor(waitingFor);
  return {
    sessionId, prompt: '', message: '', assistantText: text, thinkingText: '', tools: [],
    ...turn, id: `collaboration-live-turn:exchange:${id}`, status: 'processing', completed: false, succeeded: false, error: null,
    agentExchangeStatus: status, ...(person ? { agentExchangeWaitingFor: person } : {}),
    ...(person && forViewer ? { agentExchangeWaitingForViewer: true } : {}),
  };
}

export function withAgentExchangeProgress(message: Message, state: unknown, waitingFor?: unknown, forViewer = false): Message {
  const turn = agentExchangeProgressTurn(state, message.text, `exchange-progress:${message.id}`, '', message.turn, waitingFor, forViewer);
  return turn === message.turn || !turn ? message : { ...message, turn };
}
