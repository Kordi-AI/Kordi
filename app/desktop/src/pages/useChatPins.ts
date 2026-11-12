import { cloudMessageDeletions } from '@/features/cloud/cloudMessageDeletions';
import { MAX_PINNED_MESSAGES, sessionPinMessageIds } from '@/features/cloud/cloudSessionPinTypes';
import { cloudOperationUuid } from '@/features/cloud/chatSyncMapping';
import { mergePinHistory, type CloudPinHistoryEvent } from '@/features/cloud/cloudPinHistory';
import { remainingPendingPinActions, resolvePendingPinActions, type PendingPinAction } from '@/pages/pendingPinActions';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { createPinActivity, type PinActivity } from '@/pages/chatsPage.pinActivity';

import type { CloudSessionPin } from '@/features/cloud/authClient';
import {
  isCloudCollaborationConversationId,
  isCloudCollaborationHostId,
} from '@/features/cloud/cloudCollaborationState';
import type { Conversation, Message } from '@/kordi-app/types';
import {
  chatMessageActionId,
  type PinnedMessageItem,
  type PinnedMessageScope,
  pinnedMessageCandidateIds,
  stableCloudPinMessageId,
} from '@/pages/chatsPage.pinModel';

type PinDialog = {
  mode: 'pin' | 'unpin';
  message: Message;
  scope?: PinnedMessageScope;
  contextKey: string;
};

function pinActorLabel(
  conversation: Conversation,
  accountId: string | null,
  currentAccountId?: string | null,
) {
  if (!accountId) return 'Someone';
  if (accountId === currentAccountId) return 'You';
  const participant = conversation.canonicalParticipants?.find((candidate) => (
    [candidate.id, candidate.sourceIdentityId, candidate.humanId].includes(accountId)
  ));
  const label = participant?.publicName?.trim() || participant?.name?.trim();
  return label?.toLowerCase() === 'me' ? 'You' : label || 'Someone';
}

type UseChatPinsInput = {
  conversation: Conversation;
  messages: readonly Message[];
  sessionId: string;
  isGroupSession: boolean;
  currentAccountId?: string | null;
  cloudPin?: CloudSessionPin | null;
  onUpdateCloudPin?: (input: {
    sessionId: string;
    messageId: string | null;
    action?: 'pin' | 'unpin';
    scope: 'private' | 'shared';
  }) => Promise<CloudSessionPin>;
  onNavigateToMessage: (messageId: string) => void;
  loadBrowserPin?: (messageId: string, open?: boolean) => Promise<Message | null>;
};

export function useChatPins({
  conversation,
  messages,
  sessionId,
  isGroupSession,
  currentAccountId,
  cloudPin,
  onUpdateCloudPin,
  onNavigateToMessage,
  loadBrowserPin,
}: UseChatPinsInput) {
  const [pendingCloudActions, setPendingCloudActions] = useState<Record<string, PendingPinAction[]>>({});
  const [localPinIds, setLocalPinIds] = useState<Record<string, string[]>>({});
  const [localPinActivity, setLocalPinActivity] = useState<Record<string, PinActivity[]>>({});
  const [optimisticCloudPins, setOptimisticCloudPins] = useState<Record<string, CloudSessionPin>>({});
  const [dialog, setDialog] = useState<PinDialog | null>(null);
  const [pinForEveryone, setPinForEveryone] = useState(false);
  const [error, setError] = useState<{ contextKey: string; message: string } | null>(null);
  const usesCloudPins = Boolean(
    sessionId
      && onUpdateCloudPin
      && (
        conversation.collaborationSources.some((sourceId) => (
          isCloudCollaborationHostId(sourceId)
        ))
        || isCloudCollaborationHostId(conversation.collaborationTarget?.hostId)
        || isCloudCollaborationHostId(conversation.identity?.sourceHostId)
        || isCloudCollaborationConversationId(conversation.id)
        || isGroupSession
      ),
  );

  const pinScopeKey = JSON.stringify([currentAccountId ?? null, sessionId, conversation.id]);
  const optimisticCloudPin = optimisticCloudPins[pinScopeKey] ?? null;
  const activeCloudPin = usesCloudPins ? optimisticCloudPin ?? cloudPin ?? null : null;
  const pinTargets = useMemo<Array<{ messageId: string; scope: PinnedMessageScope }>>(() => usesCloudPins
      ? (['shared', 'private'] as const).flatMap(scope => sessionPinMessageIds(activeCloudPin, scope).map(messageId => ({ messageId, scope })))
      : (localPinIds[pinScopeKey] ?? []).map(messageId => ({ messageId, scope: 'private' })),
  [activeCloudPin, localPinIds, pinScopeKey, usesCloudPins]);
  const [browserPreviews, setBrowserPreviews] = useState<{ scope: string; messages: Map<string, Message | null> } | null>(null);
  const [navigationFailure, setNavigationFailure] = useState<{ scope: string; text: string } | null>(null);
  const pinMessage = useCallback((messageId: string) => messages.find(candidate => (
    usesCloudPins ? pinnedMessageCandidateIds(candidate, conversation.id).includes(messageId)
      : chatMessageActionId(candidate) === messageId
  )), [conversation.id, messages, usesCloudPins]);
  const unresolvedPins = JSON.stringify(loadBrowserPin
    ? [...new Set(pinTargets.map(pin => pin.messageId.trim()).filter(id => id && !pinMessage(id)))].sort()
    : []);
  useEffect(() => {
    if (!loadBrowserPin) return;
    let active = true;
    const ids = JSON.parse(unresolvedPins) as string[];
    if (ids.length) {
      void Promise.all(ids.map(async id => [id, await loadBrowserPin(id).catch(() => null)] as const))
        .then(entries => {
          if (active) setBrowserPreviews({ scope: pinScopeKey, messages: new Map(entries) });
        });
    }
    return () => { active = false; };
  }, [loadBrowserPin, pinScopeKey, unresolvedPins]);
  const pinnedMessages = useMemo<PinnedMessageItem[]>(() => {
    const seen = new Set<string>();
    const deleted = cloudMessageDeletions.ids(currentAccountId ?? null);
    return pinTargets.flatMap(({ messageId, scope }) => {
      const normalizedId = messageId?.trim();
      if (!normalizedId || seen.has(normalizedId)) return [];
      seen.add(normalizedId);
      const message = pinMessage(normalizedId);
      const cached = browserPreviews?.scope === pinScopeKey ? browserPreviews.messages.get(normalizedId) : undefined;
      const preview = deleted.has(cached?.reactionTargetMessageId ?? normalizedId) ? null : cached;
      const text = loadBrowserPin
        ? preview === null || deleted.has(normalizedId) ? 'Pinned message unavailable' : 'Loading pinned message…'
        : 'Pinned message';
      return [{ message: message ?? preview ?? { id: normalizedId, role: 'system', sender: '', text, time: '' }, scope }];
    });
  }, [browserPreviews, currentAccountId, loadBrowserPin, pinMessage, pinScopeKey, pinTargets]);
  const pinnedMessageIds = useMemo(
    () => [...new Set(pinnedMessages.map(({ message }) => chatMessageActionId(message)).filter(Boolean))],
    [pinnedMessages],
  );
  const pinActivities = useMemo(() => {
    if (!usesCloudPins) return localPinActivity[pinScopeKey] ?? [];
    const history = mergePinHistory(cloudPin?.history, optimisticCloudPin?.history);
    const actions = resolvePendingPinActions(pendingCloudActions[pinScopeKey] ?? [], history);
    const aliases = new Map(actions.flatMap(action => action.resolvedId ? [[action.resolvedId, action.event.id] as const] : []));
    const pending = remainingPendingPinActions(actions, history).map(action => action.event);
    return mergePinHistory(history, pending).flatMap((event) => {
      if (event.scope === 'private' && event.updatedByAccountId !== currentAccountId) return [];
      const actor = pinActorLabel(conversation, event.updatedByAccountId, currentAccountId);
      const presentationId = aliases.get(event.id) ?? event.id;
      const activity = createPinActivity(`pin-activity:${presentationId}`, `${actor} ${event.kind} a message`, event.updatedAt);
      return activity ? [{ ...activity, sequence: event.sequence, animate: presentationId.startsWith('local-pin:') }] : [];
    });
  }, [cloudPin?.history, optimisticCloudPin?.history, pendingCloudActions, conversation, currentAccountId, localPinActivity, pinScopeKey, usesCloudPins]);

  const pendingActions = pendingCloudActions[pinScopeKey];
  if (pendingActions?.length) {
    const resolved = resolvePendingPinActions(pendingActions, cloudPin?.history ?? []);
    if (resolved.some((action, index) => action !== pendingActions[index])) setPendingCloudActions({ ...pendingCloudActions, [pinScopeKey]: resolved });
  }

  const requestPin = useCallback((message: Message) => {
    setError(null);
    setPinForEveryone(false);
    setDialog({ mode: 'pin', message, contextKey: pinScopeKey });
  }, [pinScopeKey]);
  const requestUnpin = useCallback((message: Message, scope?: PinnedMessageScope) => {
    setError(null);
    setDialog({ mode: 'unpin', message, scope, contextKey: pinScopeKey });
  }, [pinScopeKey]);
  const openPinnedMessage = useCallback((message: Message) => {
    const messageId = chatMessageActionId(message);
    if (!messageId) return;
    setNavigationFailure(null);
    const loaded = pinMessage(messageId) ?? (message.entryId ? pinMessage(message.entryId) : undefined);
    if (!loadBrowserPin || loaded) {
      onNavigateToMessage(loaded ? chatMessageActionId(loaded) : messageId);
      return;
    }
    void loadBrowserPin(messageId, true).then(target => {
      if (target) onNavigateToMessage(target.entryId ?? messageId);
    }).catch(() => setNavigationFailure({ scope: pinScopeKey, text: 'Could not open the pinned message. Select it to try again.' }));
  }, [loadBrowserPin, onNavigateToMessage, pinMessage, pinScopeKey]);

  const confirmDialog = useCallback(() => {
    if (!dialog) return;
    if (dialog.contextKey !== pinScopeKey) { setDialog(null); return; }
    const messageId = usesCloudPins
      ? stableCloudPinMessageId(dialog.message, conversation.id)
      : chatMessageActionId(dialog.message);
    const candidateIds = pinnedMessageCandidateIds(dialog.message, conversation.id);
    if (!messageId) return;
    setError(null);

    if (usesCloudPins && onUpdateCloudPin && sessionId) {
      const sharedIds = sessionPinMessageIds(activeCloudPin, 'shared');
      const privateIds = sessionPinMessageIds(activeCloudPin, 'private');
      const scope = dialog.mode === 'pin'
        ? (pinForEveryone ? 'shared' : 'private')
        : dialog.scope
          ?? (sharedIds.some(id => candidateIds.includes(id)) ? 'shared' : 'private');
      const previousIds = scope === 'shared' ? sharedIds : privateIds;
      const targetId = dialog.mode === 'unpin' ? previousIds.find(id => candidateIds.includes(id)) ?? messageId : messageId;
      const nextIds = dialog.mode === 'pin'
        ? [...new Set([...previousIds, targetId])]
        : previousIds.filter(id => id !== targetId);
      const otherIds = scope === 'shared' ? privateIds : sharedIds;
      if (new Set([...nextIds, ...otherIds]).size > MAX_PINNED_MESSAGES) {
        setError({ contextKey: pinScopeKey, message: 'At most five messages can be pinned. Unpin a message before adding another.' });
        return;
      }
      setDialog(null);
      if (JSON.stringify(previousIds) === JSON.stringify(nextIds)) return;
      const nextMessageId = nextIds[nextIds.length - 1] ?? null;
      const base: CloudSessionPin = activeCloudPin ?? {
        sessionId,
        sharedMessageId: null,
        privateMessageId: null,
        effectiveMessageId: null,
        updatedAt: null,
      };
      const lastAction: NonNullable<CloudSessionPin['lastAction']> = {
        kind: dialog.mode === 'pin' ? 'pinned' : 'unpinned',
        scope,
        messageId: targetId,
        updatedByAccountId: null,
        actorLabel: 'You',
        updatedAt: new Date().toISOString(),
      };
      const optimistic: CloudSessionPin = scope === 'shared'
        ? {
            ...base,
            sharedMessageId: nextMessageId,
            sharedMessageIds: nextIds,
            effectiveMessageId: base.privateMessageId || nextMessageId,
            updatedAt: lastAction.updatedAt,
            lastAction,
          }
        : {
            ...base,
            privateMessageId: nextMessageId,
            privateMessageIds: nextIds,
            effectiveMessageId: nextMessageId || base.sharedMessageId,
            updatedAt: lastAction.updatedAt,
            lastAction,
          };
      const event: CloudPinHistoryEvent = {
        id: `local-pin:${cloudOperationUuid()}`, sessionId, kind: lastAction.kind, scope,
        messageId: targetId, updatedByAccountId: currentAccountId ?? '', updatedAt: lastAction.updatedAt!,
      };
      const knownIds = mergePinHistory(cloudPin?.history, base.history).map(item => item.id);
      setPendingCloudActions(current => ({ ...current, [pinScopeKey]: [...(current[pinScopeKey] ?? []), { event, knownIds }] }));
      setOptimisticCloudPins((current) => ({ ...current, [pinScopeKey]: optimistic }));
      void onUpdateCloudPin({
        sessionId,
        messageId: targetId,
        action: dialog.mode,
        scope,
      }).then((pin) => {
        // A complete server history also confirms no-op writes. Do not leave
        // a temporary notice behind when another device already made the change.
        if (pin.history !== undefined && remainingPendingPinActions([{ event, knownIds }], pin.history).length > 0) {
          setPendingCloudActions(current => ({ ...current, [pinScopeKey]: (current[pinScopeKey] ?? []).filter(action => action.event.id !== event.id) }));
        }
        // The parent store already has the authoritative response. Do not retain
        // a client-clock timestamp that could mask later updates from another device.
        setOptimisticCloudPins((current) => {
          if (current[pinScopeKey] !== optimistic) return current;
          const next = { ...current };
          delete next[pinScopeKey];
          return next;
        });
      }).catch((cause: unknown) => {
        setError({ contextKey: pinScopeKey, message: cause instanceof Error ? cause.message : 'Could not update pinned messages.' });
        setDialog(current => current ?? dialog);
        setPendingCloudActions(current => ({ ...current, [pinScopeKey]: (current[pinScopeKey] ?? []).filter(action => action.event.id !== event.id) }));
        setOptimisticCloudPins((current) => {
          if (current[pinScopeKey] !== optimistic) return current;
          const next = { ...current };
          delete next[pinScopeKey];
          return next;
        });
      });
      return;
    }

    const previousIds = localPinIds[pinScopeKey] ?? [];
    const nextIds = dialog.mode === 'pin' ? [...new Set([...previousIds, messageId])] : previousIds.filter(id => id !== messageId);
    if (nextIds.length > MAX_PINNED_MESSAGES) {
      setError({ contextKey: pinScopeKey, message: 'At most five messages can be pinned. Unpin a message before adding another.' });
      return;
    }
    setDialog(null);
    if (JSON.stringify(previousIds) === JSON.stringify(nextIds)) return;
    setLocalPinIds(current => ({ ...current, [pinScopeKey]: nextIds }));
    const timestampMs = Date.now();
    const activityId = `pin-activity:${conversation.id}:${cloudOperationUuid()}`;
    setLocalPinActivity((current) => ({
      ...current,
      [pinScopeKey]: [...(current[pinScopeKey] ?? []), {
        id: activityId,
        animate: true,
        label: `You ${dialog.mode === 'pin' ? 'pinned' : 'unpinned'} a message`,
        timestampMs,
        sequence: (current[pinScopeKey]?.slice(-1)[0]?.sequence ?? 0) + 1,
      }],
    }));
  }, [
    activeCloudPin, cloudPin?.history, currentAccountId, localPinIds,
    conversation.id,
    dialog,
    onUpdateCloudPin,
    pinForEveryone,
    pinScopeKey,
    sessionId,
    usesCloudPins,
  ]);

  return {
    pinnedMessageIds,
    pinnedMessages,
    pinActivities,
    requestPin,
    requestUnpin,
    openPinnedMessage,
    navigationError: navigationFailure?.scope === pinScopeKey ? navigationFailure.text : null,
    dialog: {
      value: dialog?.contextKey === pinScopeKey ? dialog : null,
      error: error?.contextKey === pinScopeKey ? error.message : null,
      pinForEveryone,
      setPinForEveryone,
      cancel: () => setDialog(null),
      confirm: confirmDialog,
    },
  };
}
