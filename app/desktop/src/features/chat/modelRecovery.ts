import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ErrorLineAction } from '@/components/ui/ErrorLine';
import { cloudAgentFailureCodeForError } from '@/features/cloud/cloudAgentFailureNotices';
import type {
  ComposerModelOption, ComposerModelSelection, ComposerProviderOption, ComposerRoute,
} from '@/kordi-app/components/composerModelSelection';
import type { DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { useModelAvailabilityVersion } from './modelAvailability';
import { modelRecoveryPlan, refusedTurnRoute } from './modelAvailabilityRoutes';

// A reply the provider refused for its model offers one click out: the chat's
// route moves to a model or sign-in that works, and the request runs again.
// The composer knows the route and how to change it; the transcript shows the
// failure; this context joins the two within one chat pane.

/** What the chat's composer lends the failed reply. */
export type ModelRecoveryControls = {
  selection: ComposerModelSelection & { thinking: string };
  providerOptions: ComposerProviderOption[];
  modelOptions: ComposerModelOption[];
  /** Saves a complete route, as a pick in the route menu does; false when refused. */
  applyRoute: (route: ComposerRoute) => unknown;
  /** Sends text as the owner's next message in this chat. */
  send: (text: string) => unknown;
};

export type RecoveryStore = {
  get: () => ModelRecoveryControls | null;
  set: (controls: ModelRecoveryControls | null) => void;
  subscribe: (listener: () => void) => () => void;
  messages: () => readonly Message[];
  setMessages: (messages: readonly Message[]) => void;
};

function sameRouteData(left: ModelRecoveryControls | null, right: ModelRecoveryControls | null) {
  if (!left || !right) return left === right;
  return left.selection.model === right.selection.model && left.selection.thinking === right.selection.thinking
    && left.selection.authProvider === right.selection.authProvider && left.selection.authChoice === right.selection.authChoice
    && left.providerOptions === right.providerOptions && left.modelOptions === right.modelOptions;
}

export function createModelRecoveryStore(): RecoveryStore {
  let controls: ModelRecoveryControls | null = null;
  let messages: readonly Message[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => controls,
    set: (next) => {
      const changed = !sameRouteData(controls, next);
      controls = next;
      if (changed) for (const listener of listeners) listener();
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    messages: () => messages,
    setMessages: (next) => { messages = next; },
  };
}

export const ModelRecoveryContext = createContext<RecoveryStore | null>(null);
/** Turns whose recovery already ran, so each request runs again at most once. */
const recoveredTurnIds = new Set<string>();

/** The chat's composer lends its route and send while it is mounted. */
export function useModelRecoveryRegistration(controls: ModelRecoveryControls | null) {
  const store = useContext(ModelRecoveryContext);
  useEffect(() => { store?.set(controls); });
  useEffect(() => () => store?.set(null), [store]);
}

function isModelRefusal(turn: DesktopChatTurnSnapshot | null | undefined): turn is DesktopChatTurnSnapshot {
  return Boolean(turn?.error) && cloudAgentFailureCodeForError(turn!.error) === 'model_unavailable';
}

/** The owner's own text request a failed reply answered, which can run again as sent. */
export function retryableModelRefusalRequest(turn: DesktopChatTurnSnapshot, messages: readonly Message[]): Message | null {
  const requestId = turn.replyToMessageId ?? turn.sourceMessage?.messageId;
  if (!requestId) return null;
  const request = messages.find((message) => message.id === requestId || message.clientMessageId === requestId
    || message.replyAliasIds?.includes(requestId));
  if (!request || !(request.isOwnMessage || request.role === 'user')) return null;
  if (!request.text.trim() || request.attachments?.length || request.voiceMessage) return null;
  return request;
}

/** Only the latest refused reply offers recovery; earlier ones ran on a route that has moved on. */
export function isLatestModelRefusal(turn: DesktopChatTurnSnapshot, messages: readonly Message[]) {
  const refused = messages.filter((message) => isModelRefusal(message.turn));
  return refused.length === 0 || !refused.some((message) => message.turn?.id === turn.id)
    || refused[refused.length - 1].turn?.id === turn.id;
}

const noSubscribe = () => () => undefined;

/** The failed reply's one-click recovery, or null when it has none. */
export function useModelRecoveryAction(turn: DesktopChatTurnSnapshot | null | undefined): ErrorLineAction | null {
  const store = useContext(ModelRecoveryContext);
  const readControls = () => store?.get() ?? null;
  const controls = useSyncExternalStore(store?.subscribe ?? noSubscribe, readControls, readControls);
  useModelAvailabilityVersion();
  const [busy, setBusy] = useState(false);
  const [, setRecovered] = useState(0);
  if (!store || !controls || !isModelRefusal(turn) || recoveredTurnIds.has(turn.id)) return null;
  if (!isLatestModelRefusal(turn, store.messages())) return null;
  const plan = modelRecoveryPlan({ ...controls, refused: refusedTurnRoute(turn.id) });
  if (!plan) return null;
  const run = async () => {
    const latest = store.get();
    if (!latest || recoveredTurnIds.has(turn.id)) return;
    recoveredTurnIds.add(turn.id);
    setBusy(true);
    try {
      if (await latest.applyRoute(plan.route) === false) {
        recoveredTurnIds.delete(turn.id);
        return;
      }
      const request = retryableModelRefusalRequest(turn, store.messages());
      if (request) await latest.send(request.text);
    } catch {
      recoveredTurnIds.delete(turn.id);
    } finally {
      setBusy(false);
      setRecovered((value) => value + 1);
    }
  };
  return { label: plan.label, disabled: busy, onClick: () => { void run(); } };
}

export function resetModelRecoveryForTests() {
  recoveredTurnIds.clear();
}
