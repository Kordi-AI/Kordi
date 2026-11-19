import type { ConnectorOAuthCallback, ConnectorOAuthHandoff } from '@/features/connectors/connectorsOAuthHandoff';

// The browser application receives a connector's OAuth callback on its own
// page. The server redirects the provider window there with the result in the
// fragment, the page relays the fragment over a same-origin BroadcastChannel,
// and the tab that started the flow finishes the grant with its own session.

export const CONNECTOR_OAUTH_CHANNEL = 'kordi-connector-oauth';
/** Marks an application page load as a connector callback for one flow. */
export const CONNECTOR_FLOW_PARAM = 'connectorFlow';
export const MAX_CONNECTOR_FRAGMENT_LENGTH = 8_192;

const FLOW_ID = /^[A-Za-z0-9_-]{22,128}$/;
const CALLBACK_MESSAGE = 'kordi-connector-callback';
const ACK_MESSAGE = 'kordi-connector-callback-ack';

export type ConnectorCallbackMessage = { type: typeof CALLBACK_MESSAGE; flow: string; fragment: string };
export type ConnectorCallbackAck = { type: typeof ACK_MESSAGE; flow: string };

export type ConnectorChannel = {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};

export type ConnectorPopup = {
  readonly closed: boolean;
  opener: unknown;
  close(): void;
  location: { replace(url: string): void };
};

/** A random, URL-safe id of 128 bits that ties a callback to the tab that started it. */
export function createConnectorFlowId(random: Pick<Crypto, 'getRandomValues'> = globalThis.crypto): string {
  const bytes = random.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isConnectorFlowId(value: unknown): value is string {
  return typeof value === 'string' && FLOW_ID.test(value);
}

function normalizedBasePath(basePath: string): string {
  const path = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return path.endsWith('/') ? path : `${path}/`;
}

/** The application's base path, `/app/` in production. */
export function applicationBasePath(): string {
  const base: unknown = import.meta.env?.BASE_URL;
  return normalizedBasePath(typeof base === 'string' && base ? base : '/app/');
}

/**
 * The callback page for one flow: the application's entry page with the flow
 * id in the query. The server appends the `#kordi_connector...` fragment.
 */
export function connectorCallbackUrl(origin: string, basePath: string, flow: string): string {
  const url = new URL(normalizedBasePath(basePath), origin);
  url.searchParams.set(CONNECTOR_FLOW_PARAM, flow);
  return url.toString();
}

/** Whether this page load is a connector callback rather than the application. */
export function isConnectorCallbackLocation(
  location: Pick<Location, 'pathname' | 'search'>,
  basePath = applicationBasePath(),
): boolean {
  const base = normalizedBasePath(basePath);
  const onEntryPage = location.pathname === base || location.pathname === base.slice(0, -1);
  return onEntryPage && new URLSearchParams(location.search).has(CONNECTOR_FLOW_PARAM);
}

export function connectorCallbackMessage(flow: string, fragment: string): ConnectorCallbackMessage {
  return { type: CALLBACK_MESSAGE, flow, fragment };
}

export function connectorCallbackAck(flow: string): ConnectorCallbackAck {
  return { type: ACK_MESSAGE, flow };
}

export function isConnectorCallbackFragment(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('#') && value.length > 1 && value.length <= MAX_CONNECTOR_FRAGMENT_LENGTH;
}

export function readConnectorCallbackMessage(data: unknown): ConnectorCallbackMessage | null {
  if (!data || typeof data !== 'object') return null;
  const { type, flow, fragment } = data as Record<string, unknown>;
  if (type !== CALLBACK_MESSAGE || !isConnectorFlowId(flow) || !isConnectorCallbackFragment(fragment)) return null;
  return { type, flow, fragment };
}

export function readConnectorCallbackAck(data: unknown): ConnectorCallbackAck | null {
  if (!data || typeof data !== 'object') return null;
  const { type, flow } = data as Record<string, unknown>;
  return type === ACK_MESSAGE && isConnectorFlowId(flow) ? { type, flow } : null;
}

export type BrowserConnectorOAuthEnvironment = {
  origin(): string;
  basePath: string;
  /** `window.open(url, '_blank')`; null when the pop-up was blocked. */
  openWindow(url: string): ConnectorPopup | null;
  /** Null when the browser has no BroadcastChannel; the client then polls. */
  openChannel(name: string): ConnectorChannel | null;
  createFlowId(): string;
};

function browserEnvironment(): BrowserConnectorOAuthEnvironment {
  return {
    origin: () => window.location.origin,
    basePath: applicationBasePath(),
    openWindow: (url) => window.open(url, '_blank'),
    openChannel: (name) => (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name)),
    createFlowId: () => createConnectorFlowId(),
  };
}

function openChannel(environment: BrowserConnectorOAuthEnvironment): ConnectorChannel | null {
  try {
    return environment.openChannel(CONNECTOR_OAUTH_CHANNEL);
  } catch {
    return null;
  }
}

/** Opens a window without an opener. */
function openDetached(environment: BrowserConnectorOAuthEnvironment, url: string): ConnectorPopup | null {
  let popup: ConnectorPopup | null;
  try {
    popup = environment.openWindow(url);
  } catch {
    return null;
  }
  if (!popup) return null;
  // `noopener` makes `window.open` return null, so detach the opener by hand
  // to keep the window and tell a blocked pop-up apart from an opened one.
  try {
    popup.opener = null;
  } catch {
    // Some browsers do not allow this; the page is still open.
  }
  return popup;
}

function closePopup(popup: ConnectorPopup | null) {
  try {
    if (popup && !popup.closed) popup.close();
  } catch {
    // The window may already belong to another site; leaving it open is harmless.
  }
}

type Flow = { popup: ConnectorPopup | null };

/**
 * The browser application's handoff. `prepare` opens a blank window at once,
 * before anything is awaited, so the pop-up stays tied to the click that
 * started the flow; `open` then shows the provider page in that window.
 */
export function createBrowserConnectorOAuthHandoff(
  environment: BrowserConnectorOAuthEnvironment = browserEnvironment(),
): ConnectorOAuthHandoff {
  // The flow whose provider page `open` shows next.
  let pending: Flow | null = null;

  const prepare = (): ConnectorOAuthCallback | null => {
    const channel = openChannel(environment);
    if (!channel) return null;
    const flowId = environment.createFlowId();
    const flow: Flow = { popup: openDetached(environment, '') };
    pending = flow;

    let fragment: string | null = null;
    let closed = false;
    let deliver: ((value: string) => void) | null = null;
    let stopWaiting: (() => void) | null = null;
    const onMessage = (event: MessageEvent) => {
      const message = readConnectorCallbackMessage(event.data);
      if (!message || message.flow !== flowId) return;
      // Every copy is acknowledged, so the callback page stops re-posting.
      channel.postMessage(connectorCallbackAck(flowId));
      if (fragment !== null) return;
      fragment = message.fragment;
      deliver?.(message.fragment);
    };
    const closeChannel = () => {
      if (closed) return;
      closed = true;
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
    channel.addEventListener('message', onMessage);

    return {
      redirectUrl: connectorCallbackUrl(environment.origin(), environment.basePath, flowId),
      wait(timeoutMs) {
        if (fragment !== null) {
          closeChannel();
          return Promise.resolve(fragment);
        }
        if (closed) return Promise.reject(new Error('Connecting was canceled.'));
        return new Promise<string>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            deliver = null;
            stopWaiting = null;
            closeChannel();
          };
          const timer = setTimeout(() => {
            finish();
            reject(new Error('Connecting timed out.'));
          }, timeoutMs);
          deliver = (value) => {
            finish();
            resolve(value);
          };
          stopWaiting = () => {
            finish();
            reject(new Error('Connecting was canceled.'));
          };
        });
      },
      cancel() {
        stopWaiting?.();
        closeChannel();
        if (pending === flow) pending = null;
        // A window that reached the callback page closes itself.
        if (fragment === null) closePopup(flow.popup);
        return Promise.resolve();
      },
    };
  };

  const open = (url: string): boolean => {
    const flow = pending;
    pending = null;
    const popup = flow?.popup;
    if (popup && !popup.closed) {
      try {
        popup.location.replace(url);
        return true;
      } catch {
        // Fall back to a new window below.
      }
    }
    const opened = openDetached(environment, url);
    if (flow) flow.popup = opened;
    return opened !== null;
  };

  return {
    prepare: () => Promise.resolve(prepare()),
    open: (url) => Promise.resolve(open(url)),
  };
}

export const browserConnectorOAuthHandoff = createBrowserConnectorOAuthHandoff();
