import { expect, test, type Page } from '@playwright/test';
import { account, installApiFixture, isCancelledFixtureRequest } from './apiFixture';

// Protocol fixtures: a synthetic provider page and completion code check the
// browser callback hand-off and request wiring, not a real provider consent.
const PROVIDER_CONSENT = 'https://accounts.provider.example.test/consent';
const COMPLETION_CODE = 'connector_completion_synthetic_browser_fixture';
const DEFAULT_AGENT_ID = `cloud-agent:${account.accountId}`;

const calendarConnector = {
  connectorId: 'conn_browser_fixture_calendar', provider: 'google_calendar', status: 'connected',
  readScopes: ['synthetic.calendar.read'], actScopes: [], actEnabled: false, agentIds: [DEFAULT_AGENT_ID],
  createdAt: '2026-11-05T12:00:00Z', updatedAt: '2026-11-05T12:05:00Z',
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function openConnectors(page: Page) {
  await page.goto('/app/chats');
  await page.getByRole('button', { name: 'Open profile', exact: true }).click();
  await page.getByRole('button', { name: 'Open account settings', exact: true }).click();
  await page.getByRole('button', { name: 'Connectors', exact: true }).click();
}

test('browser Connectors finishes a Google Calendar grant through the callback page', async ({ page, baseURL }) => {
  await installApiFixture(page, baseURL!, true);
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  await page.route('**/v1/cloud/auth/capabilities', route => route.fulfill({
    json: { password: true, oauthProviders: ['google', 'github'], connectorsVersion: 1 },
  }));

  let connected = false;
  let redirectAfter = '';
  const completions: string[] = [];
  await page.route(/\/v1\/cloud\/connectors(?:[/?]|$)/, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/cloud/connectors' && request.method() === 'GET') {
      return route.fulfill({ json: {
        connectors: connected ? [calendarConnector] : [],
        providers: ['google_calendar', 'gmail', 'github', 'slack'].map(provider => ({ provider, oauthReady: true })),
        agents: [{ agentId: DEFAULT_AGENT_ID, name: 'My Kordi', isDefault: true }],
      } });
    }
    if (path === '/v1/cloud/connectors/google_calendar/oauth/start' && request.method() === 'POST') {
      const input = request.postDataJSON() as { grant: string; redirectAfter?: string };
      expect(input.grant).toBe('read_only');
      expect(input.redirectAfter).toMatch(new RegExp(`^${escapeRegExp(baseURL!)}/app/\\?connectorFlow=[A-Za-z0-9_-]{22}$`));
      redirectAfter = input.redirectAfter!;
      return route.fulfill({ json: { authUrl: `${PROVIDER_CONSENT}?state=synthetic_state` } });
    }
    if (path === '/v1/cloud/connectors/oauth/complete' && request.method() === 'POST') {
      const input = request.postDataJSON() as { completionCode: string };
      completions.push(input.completionCode);
      connected = true;
      return route.fulfill({ json: { connector: calendarConnector } });
    }
    return route.fulfill({ status: 404, json: { errorCode: 'fixture_route_unavailable' } });
  });
  // The server's OAuth callback redirects the provider window to `redirectAfter`
  // with the pending grant in the fragment. WebKit cannot fulfill a redirect
  // status, so the synthetic provider page redirects by script.
  await page.context().route(`${PROVIDER_CONSENT}**`, route => {
    const target = `${redirectAfter}#kordi_connector=${base64UrlJson({
      completionCode: COMPLETION_CODE, provider: 'google_calendar', grant: 'read', status: 'pending',
    })}`;
    return route.fulfill({
      status: 200, contentType: 'text/html',
      body: `<!doctype html><title>Synthetic provider</title><script>location.replace(${JSON.stringify(target)})</script>`,
    });
  });
  const popupUrls: string[] = [];
  const popupApiRequests: string[] = [];
  let popup: Page | null = null;
  page.on('popup', opened => {
    popup = opened;
    opened.on('framenavigated', frame => { if (frame === opened.mainFrame()) popupUrls.push(frame.url()); });
    opened.on('request', request => {
      const url = new URL(request.url());
      if (/^\/v[12]\//.test(url.pathname)) popupApiRequests.push(url.pathname);
    });
  });

  await openConnectors(page);
  await page.getByRole('button', { name: 'Google Calendar, Not connected', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Google Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Continue to Google', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Disconnect Google Calendar', exact: true })).toBeVisible();
  expect(completions).toEqual([COMPLETION_CODE]);
  // The callback page relays the result, drops the fragment, and closes itself.
  await expect.poll(() => (popup as Page | null)?.isClosed() ?? false).toBe(true);
  expect(popupUrls.some(url => url.includes('#kordi_connector='))).toBe(true);
  expect(popupUrls.at(-1)).toBe(redirectAfter);
  expect(popupApiRequests).toEqual([]);

  await page.getByRole('button', { name: 'Back to connectors', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Google Calendar, Connected · Read only', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
