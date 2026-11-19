import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

import type { AppSignInResult } from '../src/features/cloud/appSignIn/appSignInClient';
import type { BrowserSignInDriver } from '../src/features/cloud/appSignIn/browserSignIn';
import type { CloudBrowserSignInSession } from '../src/features/cloud/appSignIn/cloudBrowserSignInSession';
import { CloudSignInGate } from '../src/kordi-app/cloud/CloudSignInGate';
import { installDom } from './helpers/transcriptAttachmentDom';

const ACCOUNT = { accountId: 'acct_synthetic', email: 'a@example.test', displayName: 'Synthetic' };
const TOKEN_BODY = {
  access_token: 'kordi_cs_synthetic', expires_in: 3600, refresh_token: 'kordi_rt_synthetic',
  device_id: 'dev_synthetic', account: ACCOUNT,
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let baseUrlCounter = 0;

function fakeSession({ probeStatus = 400, probeError = 'invalid_redirect_uri', tokenStatus = 200 } = {}) {
  const events: string[] = [];
  let probeAnswer = { status: probeStatus, error: probeError };
  let probes = 0;
  const completed: AppSignInResult[] = [];
  let state = '';
  let returnFromBrowser: (query: string) => void = () => {};
  let rejectWait: (error: Error) => void = () => {};
  const driver: BrowserSignInDriver = {
    prepare: async (expected) => {
      state = expected;
      return { requestId: 'req_1', redirectUrl: 'http://127.0.0.1:4321/auth/callback' };
    },
    wait: () => new Promise((resolve, reject) => { returnFromBrowser = resolve; rejectWait = reject; }),
    cancel: async () => { events.push('cancel'); rejectWait(new Error('Browser sign-in was canceled.')); },
    openUrl: async (url) => { events.push(`open ${new URL(url).pathname}`); },
  };
  // Each case gets its own origin so the gate's availability cache stays per case.
  baseUrlCounter += 1;
  const baseUrl = `https://app${baseUrlCounter}.example.test`;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/authorize?')) {
      probes += 1;
      return json(probeAnswer.status, { error: probeAnswer.error });
    }
    if (url.endsWith('/token')) return tokenStatus === 200 ? json(200, TOKEN_BODY) : json(tokenStatus, { error: 'invalid_grant' });
    return json(404, {});
  }) as typeof fetch;
  const session: CloudBrowserSignInSession = {
    config: { baseUrl, clientId: 'kordi-desktop', fetchImpl, driver, deviceRegistration: async () => { throw new Error('none'); } },
    complete: async (result) => { completed.push(result); },
  };
  return {
    session, events, completed, baseUrl, probes: () => probes,
    returnFromBrowser: (query: (state: string) => string) => returnFromBrowser(query(state)),
    /** Changes what the server answers on the next availability check. */
    answerProbe: (status: number, error: string) => { probeAnswer = { status, error }; },
  };
}

async function withDom(run: (root: Root) => Promise<void>) {
  const installed = installDom();
  // Import after the DOM is installed so React attaches input change listeners.
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
  assert.ok(match, `missing button ${name}; page: ${document.body.textContent}`);
  return match;
}

function text(): string {
  return document.body.textContent ?? '';
}

/** The app never asks for an email or password itself; the browser page does. */
function assertNoCredentialForm() {
  const fields = document.querySelectorAll(
    'input[type="email"], input[type="password"], input[autocomplete="email"], input[autocomplete="current-password"], input[autocomplete="new-password"]',
  );
  assert.equal(fields.length, 0, `credential field rendered; page: ${document.body.textContent}`);
  assert.doesNotMatch(text(), /Password|Email/);
}

/** Log in and Sign up stay visible and enabled whatever the server reported. */
function assertEntryPoints() {
  for (const name of ['Log in', 'Sign up']) assert.equal(button(name).disabled, false, `${name} is enabled`);
}

function statusLine(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="status"]');
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const render = (root: Root, browserSignIn?: CloudBrowserSignInSession) => act(async () => {
  root.render(createElement(CloudSignInGate, { browserSignIn }));
});

test('the welcome screen opens the browser and finishes from the loopback redirect', async () => {
  await withDom(async (root) => {
    const fake = fakeSession();
    await render(root, fake.session);
    await settle();
    assertNoCredentialForm();
    assert.equal(statusLine(), null, 'an available server shows no error');
    assert.match(text(), /Welcome to Kordi/);
    button('Sign up');
    assert.doesNotMatch(text(), /Trouble logging in/);

    await act(async () => { button('Log in').click(); });
    await settle();
    assert.deepEqual(fake.events, ['open /v1/cloud/auth/app/authorize']);
    assert.match(text(), /Continue in your browser/);
    assert.equal(document.activeElement?.textContent, 'Continue in your browser', 'focus moves to the wait screen');
    assert.doesNotMatch(text(), /Log in on|come back here|Link copied/, 'the wait screen has no subtitle');

    await act(async () => { button('Open browser again').click(); });
    assert.equal(fake.events.filter((event) => event.startsWith('open')).length, 2);

    await act(async () => { fake.returnFromBrowser((state) => `code=kac_1&state=${state}`); });
    await settle();
    assert.equal(fake.completed.length, 1);
    assert.equal(fake.completed[0]?.account.accountId, ACCOUNT.accountId);
    assert.equal(fake.completed[0]?.refresh.refreshToken, 'kordi_rt_synthetic');
  });
});

test('a pasted code signs in and cancel returns to the welcome screen', async () => {
  await withDom(async (root) => {
    const fake = fakeSession();
    await render(root, fake.session);
    await settle();
    await act(async () => { button('Log in').click(); });
    await settle();
    assert.deepEqual(fake.events, ['open /v1/cloud/auth/app/authorize']);

    await act(async () => { button('Cancel').click(); });
    await settle();
    assert.ok(fake.events.includes('cancel'));
    assert.match(text(), /Welcome to Kordi/);
    assert.equal(document.querySelector('[role="alert"]'), null);

    await act(async () => { button('Log in').click(); });
    await settle();
    await act(async () => { button('Paste code').click(); });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Paste code"]')!;
    await act(async () => { typeInto(input, ' kac_pasted '); });
    await act(async () => { button('Continue').click(); });
    await settle();
    assert.equal(fake.completed.length, 1);
  });
});

test('a browser refusal returns to the welcome screen with the error', async () => {
  await withDom(async (root) => {
    const fake = fakeSession();
    await render(root, fake.session);
    await settle();
    await act(async () => { button('Sign up').click(); });
    await settle();
    await act(async () => { fake.returnFromBrowser((state) => `error=access_denied&state=${state}`); });
    await settle();
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Sign-in was canceled in the browser.');
    button('Log in');
    assert.equal(fake.completed.length, 0);
  });
});

test('a refused pasted code is announced and described on the field', async () => {
  await withDom(async (root) => {
    const fake = fakeSession({ tokenStatus: 400 });
    await render(root, fake.session);
    await settle();
    await act(async () => { button('Log in').click(); });
    await settle();
    await act(async () => { button('Paste code').click(); });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Paste code"]')!;
    assert.equal(input.getAttribute('aria-describedby'), null);
    await act(async () => { typeInto(input, 'kac_expired'); });
    await act(async () => { button('Continue').click(); });
    await settle();
    const describedBy = input.getAttribute('aria-describedby');
    assert.ok(describedBy);
    assert.match(document.getElementById(describedBy)?.textContent ?? '', /expired or was already used/);
    assert.equal(fake.completed.length, 0);
  });
});

test('an inconclusive availability check keeps browser sign-in and is asked again', async () => {
  await withDom(async (root) => {
    const fake = fakeSession({ probeStatus: 429, probeError: 'rate_limited' });
    await render(root, fake.session);
    await settle();
    assertNoCredentialForm();
    assert.equal(statusLine(), null, 'an inconclusive answer shows no error');
    assert.match(text(), /Welcome to Kordi/);
    const probes = fake.probes();
    await render(root, undefined);
    await settle();
    await render(root, fake.session);
    await settle();
    assert.ok(fake.probes() > probes, 'an unknown answer is not cached');
  });
});

for (const [label, status, error] of [
  ['without the endpoint', 404, 'not_found'],
  ['without the endpoint method', 405, 'method_not_allowed'],
  ['without this app client', 400, 'invalid_client'],
] as const) {
  test(`a server ${label} keeps the welcome screen with an error and Try again`, async () => {
    await withDom(async (root) => {
      const fake = fakeSession({ probeStatus: status, probeError: error });
      await render(root, fake.session);
      await settle();
      assertNoCredentialForm();
      assert.match(text(), /Welcome to Kordi/);
      assertEntryPoints();
      assert.match(statusLine()?.textContent ?? '', /^Sign-in is unavailable on this server\./);
      const probes = fake.probes();

      // Try again asks the server again and keeps the error while it still refuses.
      await act(async () => { button('Try again').click(); });
      await settle();
      assert.equal(fake.probes(), probes + 1);
      assertNoCredentialForm();
      assert.match(statusLine()?.textContent ?? '', /Sign-in is unavailable on this server/);

      // Once the server offers browser sign-in, Try again clears the error.
      fake.answerProbe(400, 'invalid_redirect_uri');
      await act(async () => { button('Try again').click(); });
      await settle();
      assert.equal(statusLine(), null);
      assertEntryPoints();
    });
  });
}

test('Log in on a server without browser sign-in asks again and never opens a form', async () => {
  await withDom(async (root) => {
    const fake = fakeSession({ probeStatus: 404, probeError: 'not_found' });
    await render(root, fake.session);
    await settle();
    const probes = fake.probes();

    for (const name of ['Log in', 'Sign up']) {
      await act(async () => { button(name).click(); });
      await settle();
      assertNoCredentialForm();
      assert.deepEqual(fake.events, [], 'nothing opens in the browser');
      assert.match(statusLine()?.textContent ?? '', /Sign-in is unavailable on this server/);
      assertEntryPoints();
    }
    assert.equal(fake.probes(), probes + 2, 'each attempt asks the server again');

    // When the server starts offering browser sign-in, Log in goes ahead.
    fake.answerProbe(400, 'invalid_redirect_uri');
    await act(async () => { button('Log in').click(); });
    await settle();
    assert.deepEqual(fake.events, ['open /v1/cloud/auth/app/authorize']);
    assert.match(text(), /Continue in your browser/);
  });
});

test('a window that cannot run browser sign-in keeps the welcome screen with an error', async () => {
  await withDom(async (root) => {
    await render(root, undefined);
    await settle();
    assertNoCredentialForm();
    assert.match(text(), /Welcome to Kordi/);
    assertEntryPoints();
    assert.equal(statusLine()?.textContent, 'Sign-in is unavailable in this window.');

    await act(async () => { button('Log in').click(); });
    await settle();
    assertNoCredentialForm();
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Sign-in is unavailable in this window.');
    assertEntryPoints();
  });
});

test('focus rings follow the keyboard, not the opening focus or a click', async () => {
  await withDom(async (root) => {
    const fake = fakeSession();
    await render(root, fake.session);
    await settle();
    const frame = () => document.querySelector('.app-cloud-browser-signin')?.hasAttribute('data-keyboard-focus');
    assert.equal(frame(), false, 'opening the window draws no ring');
    for (const key of ['Tab', 'Enter', ' ', 'ArrowDown']) {
      await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key })); });
      assert.equal(frame(), true, `${JSON.stringify(key)} shows the ring`);
      await act(async () => { document.dispatchEvent(new window.Event('pointerdown')); });
      assert.equal(frame(), false, 'a click hides the ring');
    }
    await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' })); });
    assert.equal(frame(), false, 'typing does not show the ring');
  });
});
