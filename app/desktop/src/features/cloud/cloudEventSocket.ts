import { cloudRealtimeWebSocketEnabled, cloudWebSocketUrl } from './cloudApiEnvironment';
import { createReconnectLoop, type ReconnectLoopOptions } from './reconnectLoop';
import { loadSession } from './session';

/** A parsed frame of the account event socket (`/v1/cloud/ws`). */
export type CloudEventFrame = { subject: string; payload: unknown };

export type CloudEventSocket = { close(): void };

export type CloudEventSocketOptions = {
  onFrame: (frame: CloudEventFrame, token: string) => void;
  /** A malformed frame, or one `onFrame` threw on; ignored when absent, since polling repairs the state. */
  onFrameError?: (error: unknown) => void;
  /** Test seams for the reconnect timing and signals. */
  loop?: Omit<ReconnectLoopOptions, 'connect' | 'onError' | 'onResume'>;
};

/**
 * Opens the account event socket and keeps it open: a closed socket reconnects
 * with the shared backoff, and at once when the network or the window returns.
 * Returns null when this runtime has no realtime sockets.
 */
export function openCloudEventSocket(options: CloudEventSocketOptions): CloudEventSocket | null {
  if (typeof WebSocket === 'undefined' || !cloudRealtimeWebSocketEnabled()) return null;
  let socket: WebSocket | null = null;
  const loop = createReconnectLoop({
    ...options.loop,
    connect: async (attempt) => {
      const session = await loadSession();
      if (!attempt.current) return;
      if (!session?.token) {
        attempt.idle();
        return;
      }
      const ws = new WebSocket(cloudWebSocketUrl(session.token));
      socket = ws;
      ws.onopen = () => attempt.opened();
      ws.onmessage = (event) => {
        if (socket !== ws) return;
        try {
          const frame = JSON.parse(typeof event.data === 'string' ? event.data : '') as { subject?: unknown; payload?: unknown } | null;
          const subject = typeof frame?.subject === 'string' ? frame.subject : '';
          options.onFrame({ subject, payload: frame?.payload }, session.token);
        } catch (error) {
          options.onFrameError?.(error);
        }
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
        attempt.closed();
      };
      ws.onerror = () => ws.close();
    },
  });
  loop.start();
  return {
    close() {
      loop.stop();
      const current = socket;
      socket = null;
      current?.close();
    },
  };
}
