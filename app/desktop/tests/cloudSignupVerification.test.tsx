import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, useState } from 'react';

import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import type { CloudSignupCodeChallenge } from '../src/features/cloud/signupEmailTypes';
import { CloudSignupVerificationFields } from '../src/kordi-app/cloud/CloudSignupVerificationFields';
import { useCloudSignupVerification } from '../src/kordi-app/cloud/useCloudSignupVerification';
import { installDom } from './helpers/transcriptAttachmentDom';

// The emailed-code hook and fields are shared by the account email row and
// the Delete account dialog. This harness drives them the way both do.

function Harness({
  requestCode,
  allowChange = true,
}: {
  requestCode?: (email: string) => Promise<CloudSignupCodeChallenge>;
  allowChange?: boolean;
}) {
  const [email, setEmail] = useState('owner@example.com');
  const [error, setError] = useState<string | null>(null);
  const { challenge, verificationCode, setVerificationCode, resendSeconds, sendCode, resetVerification } =
    useCloudSignupVerification(email, requestCode);
  const send = () => {
    setError(null);
    sendCode().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'failed'));
  };
  return createElement('div', null,
    createElement('input', {
      'aria-label': 'Address', value: email,
      onChange: (event: { currentTarget: HTMLInputElement }) => { setEmail(event.currentTarget.value); resetVerification(); },
    }),
    challenge
      ? createElement(CloudSignupVerificationFields, {
        email, busy: false, resendSeconds, onResend: send,
        onChangeEmail: allowChange ? resetVerification : undefined,
        children: createElement('input', {
          'aria-label': 'Code', autoComplete: 'one-time-code', value: verificationCode,
          onChange: (event: { currentTarget: HTMLInputElement }) => setVerificationCode(event.currentTarget.value),
        }),
      })
      : createElement('button', { type: 'button', onClick: send }, 'Send code'),
    challenge ? createElement('output', null, challenge.verificationId) : null,
    error ? createElement('p', { role: 'alert' }, error) : null,
  );
}

async function render(props: Parameters<typeof Harness>[0]) {
  const installed = installDom();
  // Import after the DOM is installed so React attaches input change listeners.
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness, props)));
  const button = (name: string) => [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === name) ?? null;
  const field = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  const fill = async (label: string, value: string) => {
    const input = field(label)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(installed.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new installed.dom.window.Event('input', { bubbles: true }));
    });
  };
  return {
    host, button, field, fill,
    cleanup: async () => {
      await act(async () => root.unmount());
      installed.restore();
    },
  };
}

test('a sent code holds Resend for its cooldown, and Change email clears the proof', async () => {
  const sent: string[] = [];
  const view = await render({
    requestCode: async (email) => {
      sent.push(email);
      return { verificationId: `email_${sent.length}`, expiresAt: '2099-01-01T00:00:00Z', retryAfterSeconds: 60 };
    },
  });
  try {
    await act(async () => view.button('Send code')!.click());
    assert.deepEqual(sent, ['owner@example.com']);
    assert.match(view.host.textContent!, /Enter the 6-digit code sent to owner@example\.com/);
    assert.equal(view.button('Resend in 60s')?.disabled, true);
    assert.equal(view.host.querySelector('output')?.textContent, 'email_1');

    await view.fill('Code', '123456');
    await act(async () => view.button('Change email')!.click());
    assert.equal(view.field('Code'), null, 'the code field closes');
    assert.equal(view.host.querySelector('output'), null, 'the challenge is dropped');

    await view.fill('Address', 'other@example.com');
    await act(async () => view.button('Send code')!.click());
    assert.deepEqual(sent, ['owner@example.com', 'other@example.com']);
    assert.equal(view.field('Code')!.value, '', 'a new code starts empty');
    assert.equal(view.host.querySelector('output')?.textContent, 'email_2');
  } finally {
    await view.cleanup();
  }
});

test('a cooldown answer arms the countdown, and the fields hide Change email where the address is fixed', async () => {
  let calls = 0;
  const view = await render({
    allowChange: false,
    requestCode: async () => {
      calls += 1;
      if (calls === 2) throw new CloudAuthError('rate_limited', 'Too many attempts.', 429, 42);
      return { verificationId: 'email_1', expiresAt: '2099-01-01T00:00:00Z', retryAfterSeconds: 0 };
    },
  });
  try {
    await act(async () => view.button('Send code')!.click());
    assert.equal(view.button('Change email'), null);
    assert.equal(view.button('Resend code')?.disabled, false);
    await act(async () => view.button('Resend code')!.click());
    assert.equal(calls, 2);
    assert.equal(view.host.querySelector('[role="alert"]')?.textContent, 'Too many attempts.');
    assert.equal(view.button('Resend in 42s')?.disabled, true);
  } finally {
    await view.cleanup();
  }
});

test('without a code request the hook reports that email verification is unavailable', async () => {
  const view = await render({ requestCode: undefined });
  try {
    await act(async () => view.button('Send code')!.click());
    assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? '', /Email verification is unavailable/);
    assert.equal(view.field('Code'), null);
  } finally {
    await view.cleanup();
  }
});
