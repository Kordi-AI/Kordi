import { readStoredThemeMode, resolveThemeMode } from '@/app/themePreference';

import {
  CONNECTOR_FLOW_PARAM,
  CONNECTOR_OAUTH_CHANNEL,
  connectorCallbackMessage,
  isConnectorCallbackFragment,
  isConnectorFlowId,
  readConnectorCallbackAck,
  type ConnectorChannel,
} from './browserConnectorOAuth';

// The page a connector sign-in returns to in the browser application. It only
// hands the result to the tab that started the flow; that tab finishes the
// grant. The application is not started here and nothing is stored.

const REPOST_INTERVAL_MS = 500;
const REPOST_LIMIT_MS = 120_000;

export type ConnectorCallbackView = 'waiting' | 'connected' | 'not_connected' | 'return';

const COPY: Record<ConnectorCallbackView, { title: string; detail: string }> = {
  waiting: { title: 'Connecting', detail: 'Finishing in Kordi…' },
  connected: { title: 'Connected', detail: 'You can close this tab.' },
  not_connected: { title: 'Not connected', detail: 'You can close this tab and try again in Kordi.' },
  return: { title: 'Not connected', detail: 'Return to Kordi and try again.' },
};

export function connectorCallbackCopy(view: ConnectorCallbackView) {
  return COPY[view];
}

/** Whether the fragment carries a connection result, an error, or neither. */
export function connectorCallbackFragmentKind(fragment: string): 'result' | 'error' | null {
  if (!isConnectorCallbackFragment(fragment)) return null;
  const params = new URLSearchParams(fragment.slice(1));
  if (params.get('kordi_connector_error')?.trim()) return 'error';
  if (params.get('kordi_connector')?.trim()) return 'result';
  return null;
}

export type ConnectorCallbackPageEnvironment = {
  location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  history: Pick<History, 'replaceState' | 'state'>;
  openChannel: (name: string) => ConnectorChannel | null;
  render: (view: ConnectorCallbackView) => void;
  closeWindow: () => void;
  repostIntervalMs?: number;
  repostLimitMs?: number;
};

function openRelay(environment: ConnectorCallbackPageEnvironment): ConnectorChannel | null {
  try {
    return environment.openChannel(CONNECTOR_OAUTH_CHANNEL);
  } catch {
    return null;
  }
}

/** Relays the callback fragment until the starting tab acknowledges it. Returns a stop function. */
export function runConnectorCallbackPage(environment: ConnectorCallbackPageEnvironment): () => void {
  const { location, history, render } = environment;
  const fragment = location.hash;
  const flow = new URLSearchParams(location.search).get(CONNECTOR_FLOW_PARAM);
  // The fragment carries a one-use completion code: keep it out of the
  // address bar and the session history.
  if (fragment) history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  const kind = connectorCallbackFragmentKind(fragment);
  const relay = kind && isConnectorFlowId(flow) ? openRelay(environment) : null;
  if (!kind || !isConnectorFlowId(flow) || !relay) {
    render('return');
    return () => undefined;
  }
  render(kind === 'error' ? 'not_connected' : 'waiting');

  const message = connectorCallbackMessage(flow, fragment);
  const intervalMs = environment.repostIntervalMs ?? REPOST_INTERVAL_MS;
  const attempts = Math.max(1, Math.ceil((environment.repostLimitMs ?? REPOST_LIMIT_MS) / intervalMs));
  let posted = 0;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    relay.removeEventListener('message', onMessage);
    relay.close();
  };
  function onMessage(event: MessageEvent) {
    const ack = readConnectorCallbackAck(event.data);
    if (!ack || ack.flow !== flow) return;
    stop();
    if (kind === 'result') {
      render('connected');
      environment.closeWindow();
    }
  }
  const post = () => {
    posted += 1;
    relay.postMessage(message);
  };
  // The starting tab may be throttled in the background, so re-post until it answers.
  const interval = setInterval(() => {
    if (posted >= attempts) {
      stop();
      render('return');
      return;
    }
    post();
  }, intervalMs);
  relay.addEventListener('message', onMessage);
  post();
  return stop;
}

/** Plain DOM for the callback page, themed like the application's standalone windows. */
export function createConnectorCallbackRenderer(document: Document, root: HTMLElement) {
  const view = document.defaultView;
  const systemTheme = view?.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const theme = resolveThemeMode(readStoredThemeMode(), systemTheme);
  document.documentElement.style.colorScheme = theme;
  document.body.classList.add(`theme-${theme}`);

  const page = document.createElement('main');
  page.className = `kordi-app theme-${theme} flex h-[100dvh] w-full items-center justify-center bg-[color:var(--app-main-bg)] px-6 py-8 text-[color:var(--utility-foreground)]`;
  const status = document.createElement('div');
  status.className = 'max-w-sm text-center';
  status.setAttribute('role', 'status');
  const title = document.createElement('h1');
  title.className = 'm-0 text-[17px] font-semibold';
  const detail = document.createElement('p');
  detail.className = 'm-0 mt-1.5 text-[13px] text-[color:var(--utility-muted-text)]';
  status.append(title, detail);
  page.append(status);
  root.replaceChildren(page);

  return (next: ConnectorCallbackView) => {
    const copy = connectorCallbackCopy(next);
    title.textContent = copy.title;
    detail.textContent = copy.detail;
  };
}

/** Starts the callback page in this window. */
export function showConnectorCallbackPage(browser: Window, root: HTMLElement): void {
  runConnectorCallbackPage({
    location: browser.location,
    history: browser.history,
    openChannel: (name) => (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name)),
    render: createConnectorCallbackRenderer(browser.document, root),
    closeWindow: () => browser.close(),
  });
}
