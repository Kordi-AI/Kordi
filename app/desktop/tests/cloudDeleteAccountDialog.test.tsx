import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';

import { CloudAuthError } from '../src/features/cloud/authClient';
import type {
  AccountDeletionProof,
  AccountSecurityClient,
  AccountSecurityOverview,
  DeletedAccountSession,
} from '../src/features/cloud/accountSecurityClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';

const SUMMARY = "Your account, contacts, files, agents and memories are deleted. This can't be undone.";
const ended: DeletedAccountSession = { token: 'synthetic-token', accountId: 'acct_owner' };
const challenge = { verificationId: 'reauth_1', expiresAt: '2099-01-01T00:00:00Z', retryAfterSeconds: 60 };

function overview(partial: { password?: boolean; email?: string | null; recentSignIn?: boolean }): AccountSecurityOverview {
  return {
    email: { address: partial.email === undefined ? 'owner@example.test' : partial.email, verified: true },
    password: { set: partial.password ?? false },
    recentSignIn: partial.recentSignIn ?? false,
  };
}

type FakeClient = AccountSecurityClient & {
  deletions: AccountDeletionProof[];
  codeRequests: () => number;
  overviewRequests: () => number;
};

function fakeClient({
  load = async () => overview({}),
  requestCode = async () => challenge,
  deleteAccount = async () => ended,
}: {
  load?: () => Promise<AccountSecurityOverview>;
  requestCode?: () => Promise<typeof challenge>;
  deleteAccount?: (proof: AccountDeletionProof) => Promise<DeletedAccountSession>;
}): FakeClient {
  const deletions: AccountDeletionProof[] = [];
  let codes = 0;
  let loads = 0;
  return {
    deletions,
    codeRequests: () => codes,
    overviewRequests: () => loads,
    overview: async () => { loads += 1; return load(); },
    requestCode: async () => { codes += 1; return requestCode(); },
    deleteAccount: async (proof) => { deletions.push(proof); return deleteAccount(proof); },
  };
}

async function renderDialog(client: FakeClient) {
  const installed = installDom();
  const { createRoot } = await import('react-dom/client');
  const { default: CloudDeleteAccountDialog } = await import('../src/features/cloud/CloudDeleteAccountDialog');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const deleted: DeletedAccountSession[] = [];
  let dismissed = 0;
  await act(async () => root.render(createElement(CloudDeleteAccountDialog, {
    client,
    onDismiss: () => { dismissed += 1; },
    onDeleted: async (session: DeletedAccountSession) => { deleted.push(session); },
  })));
  await flushReactUpdates();
  const body = () => document.body;
  return {
    deleted,
    dismissed: () => dismissed,
    text: () => body().textContent ?? '',
    button(text: string) {
      return Array.from(body().querySelectorAll('button')).find((button) => button.textContent === text) ?? null;
    },
    input(label: string) {
      return body().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    },
    async click(text: string) {
      const button = this.button(text);
      assert.ok(button, `button ${text}`);
      await act(async () => button.click());
      await flushReactUpdates();
    },
    async fill(label: string, value: string) {
      const input = this.input(label);
      assert.ok(input, `input ${label}`);
      await act(async () => {
        Object.getOwnPropertyDescriptor(installed.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new installed.dom.window.Event('input', { bubbles: true }));
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      installed.restore();
    },
  };
}

test('a password account confirms with the current password, then a final confirmation', async () => {
  const client = fakeClient({ load: async () => overview({ password: true, recentSignIn: true }) });
  const view = await renderDialog(client);
  try {
    assert.match(view.text(), /Delete account/);
    assert.ok(view.text().includes(SUMMARY));
    assert.equal(view.button('Delete account')!.disabled, true);
    await view.fill('Current password', 'Synthetic-pass-1');
    assert.equal(view.button('Delete account')!.disabled, false);

    await view.click('Delete account');
    assert.match(view.text(), /Delete account\?/);
    assert.match(view.text(), /This can't be undone\./);
    assert.equal(client.deletions.length, 0);

    await view.click('Cancel');
    assert.equal(view.input('Current password')!.value, 'Synthetic-pass-1');
    await view.click('Delete account');
    await view.click('Delete');
    assert.deepEqual(client.deletions, [{ currentPassword: 'Synthetic-pass-1' }]);
    assert.deepEqual(view.deleted, [ended]);
  } finally {
    await view.cleanup();
  }
});

test('a wrong password returns to the proof step with a short message', async () => {
  const client = fakeClient({
    load: async () => overview({ password: true }),
    deleteAccount: async () => { throw new CloudAuthError('invalid_current_password', 'The current password is incorrect.', 403); },
  });
  const view = await renderDialog(client);
  try {
    await view.fill('Current password', 'wrong');
    await view.click('Delete account');
    await view.click('Delete');
    assert.match(view.text(), /That password is incorrect\./);
    assert.ok(view.input('Current password'));
    assert.deepEqual(view.deleted, []);
    // Typing again clears the message.
    await view.fill('Current password', 'Synthetic-pass-1');
    assert.doesNotMatch(view.text(), /That password is incorrect\./);
  } finally {
    await view.cleanup();
  }
});

test('an account without a password emails a code and deletes with it', async () => {
  const client = fakeClient({});
  const view = await renderDialog(client);
  try {
    assert.equal(view.button('Delete account')!.disabled, true);
    await view.click('Email me a code');
    assert.equal(client.codeRequests(), 1);
    assert.match(view.text(), /Enter the 6-digit code sent to owner@example\.test/);
    assert.equal(view.button('Resend in 60s')!.disabled, true);
    assert.equal(view.button('Change email'), null);

    await view.fill('Email code', '12ab34');
    assert.equal(view.input('Email code')!.value, '1234');
    assert.equal(view.button('Delete account')!.disabled, true);
    await view.fill('Email code', '123456');
    assert.equal(view.button('Delete account')!.disabled, false);
    await view.click('Delete account');
    await view.click('Delete');
    assert.deepEqual(client.deletions, [{ verificationId: 'reauth_1', verificationCode: '123456' }]);
    assert.deepEqual(view.deleted, [ended]);
  } finally {
    await view.cleanup();
  }
});

test('code refusals: a wrong code, a rate limit, and an account without email', async () => {
  let codeAnswer: () => Promise<typeof challenge> = async () => {
    throw new CloudAuthError('rate_limited', 'Slow down.', 429, 42);
  };
  const client = fakeClient({
    requestCode: () => codeAnswer(),
    deleteAccount: async () => { throw new CloudAuthError('invalid_verification_code', 'The email code is invalid or expired.', 400); },
  });
  const view = await renderDialog(client);
  try {
    await view.click('Email me a code');
    assert.match(view.text(), /Too many attempts\. Try again in 42 seconds\./);
    assert.equal(view.button('Email me a code (42s)')!.disabled, true);
    assert.equal(view.input('Email code'), null);
  } finally {
    await view.cleanup();
  }

  codeAnswer = async () => challenge;
  const wrong = await renderDialog(client);
  try {
    await wrong.click('Email me a code');
    await wrong.fill('Email code', '000000');
    await wrong.click('Delete account');
    await wrong.click('Delete');
    assert.match(wrong.text(), /That code is invalid or expired\./);
    assert.equal(wrong.input('Email code')!.value, '000000');
  } finally {
    await wrong.cleanup();
  }

  codeAnswer = async () => { throw new CloudAuthError('email_missing', 'Add an email address first.', 400); };
  const missing = await renderDialog(client);
  try {
    await missing.click('Email me a code');
    assert.match(missing.text(), /Sign in again to delete your account\./);
    assert.equal(missing.button('Email me a code'), null);
    assert.equal(missing.button('Delete account')!.disabled, true);
  } finally {
    await missing.cleanup();
  }
});

test('a recent sign-in needs no proof, and a lapsed one asks for a code instead', async () => {
  let refuse = false;
  const client = fakeClient({
    load: async () => overview({ recentSignIn: true }),
    deleteAccount: async () => {
      if (refuse) throw new CloudAuthError('reauthentication_required', "Confirm it's you with the code we email you.", 403);
      return ended;
    },
  });
  refuse = true;
  const view = await renderDialog(client);
  try {
    assert.equal(view.input('Current password'), null);
    assert.equal(view.button('Email me a code'), null);
    assert.equal(view.button('Delete account')!.disabled, false);
    await view.click('Delete account');
    await view.click('Delete');
    assert.deepEqual(client.deletions, [{}]);
    assert.match(view.text(), /Confirm it's you with an emailed code\./);
    assert.ok(view.button('Email me a code'));
    assert.equal(view.button('Delete account')!.disabled, true);
    assert.deepEqual(view.deleted, []);

    refuse = false;
    await view.click('Email me a code');
    await view.fill('Email code', '654321');
    await view.click('Delete account');
    await view.click('Delete');
    assert.deepEqual(client.deletions[1], { verificationId: 'reauth_1', verificationCode: '654321' });
    assert.deepEqual(view.deleted, [ended]);
  } finally {
    await view.cleanup();
  }
});

test('no password, no email and no recent sign-in asks to sign in again', async () => {
  const view = await renderDialog(fakeClient({ load: async () => overview({ email: null }) }));
  try {
    assert.match(view.text(), /Sign in again to delete your account\./);
    assert.equal(view.button('Delete account')!.disabled, true);
    await view.click('Cancel');
    assert.equal(view.dismissed(), 1);
  } finally {
    await view.cleanup();
  }
});

test('a changed account reloads its proof, and a failed load can be retried', async () => {
  let loads = 0;
  const client = fakeClient({
    load: async () => {
      loads += 1;
      if (loads === 1) throw new CloudAuthError('network_error', 'offline', 0);
      return overview({ password: loads > 2, recentSignIn: true });
    },
    deleteAccount: async () => { throw new CloudAuthError('account_changed', 'Your account changed.', 409); },
  });
  const view = await renderDialog(client);
  try {
    assert.match(view.text(), /Could not load your account\./);
    await view.click('Try again');
    assert.equal(view.button('Delete account')!.disabled, false);
    await view.click('Delete account');
    await view.click('Delete');
    assert.match(view.text(), /Your account changed\. Try again\./);
    assert.equal(client.overviewRequests(), 3);
    assert.ok(view.input('Current password'));
  } finally {
    await view.cleanup();
  }
});

test('the profile row loads the dialog on first use', async () => {
  const installed = installDom();
  __setSessionBackendForTests({ load: async () => null, save: async () => {}, clear: async () => {} });
  const { createRoot } = await import('react-dom/client');
  const { CloudDeleteAccountRow } = await import('../src/features/cloud/CloudDeleteAccountRow');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(CloudDeleteAccountRow)));
    assert.match(host.textContent!, /Delete account/);
    assert.equal(document.body.querySelector('[role="dialog"]'), null);
    const open = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Delete')!;
    await act(async () => open.click());
    for (let attempt = 0; attempt < 20 && !document.body.querySelector('[role="dialog"]'); attempt += 1) {
      await flushReactUpdates();
    }
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.ok(dialog.textContent!.includes(SUMMARY));
    // Signed out, the overview cannot load; nothing is sent.
    for (let attempt = 0; attempt < 20 && !/Could not load/.test(dialog.textContent!); attempt += 1) await flushReactUpdates();
    assert.match(dialog.textContent!, /Could not load your account\./);
  } finally {
    await act(async () => root.unmount());
    __setSessionBackendForTests(null);
    installed.restore();
  }
});
