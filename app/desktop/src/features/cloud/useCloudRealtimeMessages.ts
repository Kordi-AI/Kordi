import {
  useEffect,
  useRef,
} from 'react';
import {
  chatSyncWebSocketUrl,
  cloudRealtimeWebSocketEnabled,
  type CloudAccount,
  type CloudAuthClient,
  type CloudMessage,
  type CloudSyncEvent,
  type ChatSyncEvent,
} from './authClient';
import { publishCloudCallEvents } from './cloudCalls';
import {
  CLOUD_CONTACT_ACCEPTED_SYNC_EVENT,
} from './useCloudContacts';
import type {
  CloudMessageSyncController,
} from './useCloudMessageSync';
import {
  loadSession,
} from './session';
import { createReconnectLoop } from './reconnectLoop';
import { loadChatSyncCursor } from '@/lib/desktopChatSync';

type SyncCloudCollaborationDiff =
  CloudMessageSyncController['syncCloudCollaborationDiff'];

/** How long a liveness heartbeat sent on wake or reconnect waits for its ack. */
export const CLOUD_REALTIME_PROBE_ACK_MS = 10_000;
const HEARTBEAT_ACK_MS = 45_000;

/**
 * The position a heartbeat reports: what the local store applied, but never
 * past the last event this socket delivered, which the server refuses.
 */
export function realtimeHeartbeatAppliedSeq(appliedSeq: number, receivedSeq: number): number {
  return Math.min(appliedSeq, receivedSeq);
}

export function realtimeCallSyncEvent(event: ChatSyncEvent | undefined): CloudSyncEvent | null {
  if (!event || (event.type !== 'call.created' && event.type !== 'call.updated')) return null;
  return {
    eventId: event.event_id,
    eventType: event.type,
    peerAccountId: null,
    messageId: null,
    payload: { ...event.payload, sessionId: event.conversation_id },
    occurredAt: event.occurred_at,
  };
}

export function useCloudRealtimeMessages({
  account,
  client,
  mergeMessage,
  syncCloudCollaborationDiff,
  setRealtimeConnected,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  mergeMessage: (message: CloudMessage) => void;
  syncCloudCollaborationDiff: SyncCloudCollaborationDiff;
  setRealtimeConnected: (connected: boolean) => void;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const accountId = account?.accountId;
  const mergeMessageRef = useRef(mergeMessage);
  const syncCloudCollaborationDiffRef = useRef(
    syncCloudCollaborationDiff,
  );

  useEffect(() => {
    mergeMessageRef.current = mergeMessage;
  }, [mergeMessage]);

  useEffect(() => {
    syncCloudCollaborationDiffRef.current =
      syncCloudCollaborationDiff;
  }, [syncCloudCollaborationDiff]);

  useEffect(() => {
    if (!accountId || typeof window === 'undefined') {
      return undefined;
    }
    const handleAcceptedContact = (event: Event) => {
      const detail =
        event instanceof CustomEvent
        && event.detail
        && typeof event.detail === 'object'
          ? event.detail as { message?: CloudMessage }
          : null;
      if (detail?.message) {
        mergeMessageRef.current(detail.message);
      }
    };
    window.addEventListener(
      CLOUD_CONTACT_ACCEPTED_SYNC_EVENT,
      handleAcceptedContact,
    );
    return () => {
      window.removeEventListener(
        CLOUD_CONTACT_ACCEPTED_SYNC_EVENT,
        handleAcceptedContact,
      );
    };
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    // Pin the socket to the account lifetime. Canonical state updates
    // frequently change callback identities; refs keep the socket stable.
    if (!cloudRealtimeWebSocketEnabled()) return;
    let ws: WebSocket | null = null;
    let helloReceived = false;
    let heartbeatTimer: number | null = null;
    let heartbeatDeadlineTimer: number | null = null;
    let initialHeartbeatTimer: number | null = null;
    let heartbeatAwaitingAck = false;
    let lastAppliedSeq = 0;
    let receivedSeq = 0;
    const accountIdAtOpen = accountId;
    setRealtimeConnected(false);

    const clearHeartbeatTimers = () => {
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      if (heartbeatDeadlineTimer !== null) window.clearTimeout(heartbeatDeadlineTimer);
      if (initialHeartbeatTimer !== null) window.clearTimeout(initialHeartbeatTimer);
      heartbeatTimer = null;
      heartbeatDeadlineTimer = null;
      initialHeartbeatTimer = null;
      heartbeatAwaitingAck = false;
    };

    const sendHeartbeat = (socket: WebSocket, ackWithinMs = HEARTBEAT_ACK_MS) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (heartbeatAwaitingAck) {
        socket.close();
        return;
      }
      heartbeatAwaitingAck = true;
      socket.send(JSON.stringify({
        type: 'heartbeat',
        last_applied_seq: realtimeHeartbeatAppliedSeq(lastAppliedSeq, receivedSeq),
      }));
      heartbeatDeadlineTimer = window.setTimeout(() => socket.close(), ackWithinMs);
    };

    const loop = createReconnectLoop({
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (timer) => window.clearTimeout(timer as number),
      onError: (error) => reportWarning('[cloud-collaboration-ws] connection failed', error),
      // Back from sleep or offline, an open-looking socket may be dead: ask for an ack now.
      onResume: () => {
        if (ws && helloReceived && !heartbeatAwaitingAck) sendHeartbeat(ws, CLOUD_REALTIME_PROBE_ACK_MS);
      },
      connect: async (attempt) => {
        const session = await loadSession();
        if (!attempt.current) return;
        if (!session?.token || session.accountId !== accountIdAtOpen) {
          attempt.idle();
          return;
        }
        // Catch up from the saved cursor first; a failure waits for the next attempt.
        await syncCloudCollaborationDiffRef.current();
        const local = await loadChatSyncCursor(accountIdAtOpen);
        if (!attempt.current) return;
        if (!local?.cursor) {
          throw new Error('Reliable chat cursor is unavailable after bootstrap.');
        }
        lastAppliedSeq = local.lastStreamSeq;
        receivedSeq = local.lastStreamSeq;
        const realtime = await client.issueChatSyncRealtimeTicket(session.token);
        if (!attempt.current) return;
        const socket = new WebSocket(chatSyncWebSocketUrl(realtime.ticket));
        ws = socket;
        helloReceived = false;
        socket.onopen = () => {
          if (ws !== socket) return;
          attempt.opened();
          socket.send(JSON.stringify({
            type: 'connect',
            protocol_version: 2,
            device_id: realtime.device_id,
            cursor: local.cursor,
          }));
        };
        socket.onmessage = (event) => {
          if (ws !== socket) return;
          try {
            const frame = JSON.parse(typeof event.data === 'string' ? event.data : '') as {
              type?: string;
              stream_seq?: number;
              heartbeat_interval_ms?: number;
              event?: ChatSyncEvent;
            };
            if (frame.type === 'hello') {
              helloReceived = true;
              setRealtimeConnected(true);
              const interval = Math.max(5_000, frame.heartbeat_interval_ms ?? 30_000);
              clearHeartbeatTimers();
              heartbeatTimer = window.setInterval(() => sendHeartbeat(socket), interval);
              initialHeartbeatTimer = window.setTimeout(
                () => sendHeartbeat(socket),
                Math.floor(Math.random() * interval),
              );
              return;
            }
            if (frame.type === 'heartbeat_ack') {
              if (heartbeatDeadlineTimer !== null) window.clearTimeout(heartbeatDeadlineTimer);
              heartbeatDeadlineTimer = null;
              heartbeatAwaitingAck = false;
              return;
            }
            if (frame.type === 'resync_required') {
              // The catch-up decides: it resumes from the cursor and reloads only
              // when the server says the cursor expired.
              setRealtimeConnected(false);
              void syncCloudCollaborationDiffRef.current().catch(() => {}).finally(() => socket.close());
              return;
            }
            if (frame.type !== 'event' || typeof frame.stream_seq !== 'number') return;
            receivedSeq = Math.max(receivedSeq, frame.stream_seq);
            const callEvent = realtimeCallSyncEvent(frame.event);
            if (callEvent) publishCloudCallEvents([callEvent], accountIdAtOpen);
            void syncCloudCollaborationDiffRef.current()
              .then(async () => {
                const applied = await loadChatSyncCursor(accountIdAtOpen);
                if (applied) lastAppliedSeq = Math.max(lastAppliedSeq, applied.lastStreamSeq);
              })
              .catch(() => socket.close());
          } catch (error) {
            reportWarning(
              '[cloud-collaboration-ws] frame parse failed',
              error,
            );
          }
        };
        socket.onclose = () => {
          if (ws !== socket) return;
          setRealtimeConnected(false);
          ws = null;
          helloReceived = false;
          clearHeartbeatTimers();
          attempt.closed();
        };
        socket.onerror = () => {
          if (ws !== socket) return;
          setRealtimeConnected(false);
          socket.close();
        };
      },
    });
    loop.start();
    return () => {
      loop.stop();
      setRealtimeConnected(false);
      clearHeartbeatTimers();
      const socket = ws;
      ws = null;
      socket?.close();
    };
  }, [accountId, client, reportWarning, setRealtimeConnected]);
}
