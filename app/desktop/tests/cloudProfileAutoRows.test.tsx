import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, useEffect } from 'react';

import type { CloudProfileUpdateInput } from '../src/features/cloud/authClient';
import type { CloudAccount } from '../src/features/cloud/cloudIdentityTypes';
import { CloudProfileAutoRows, type ProfileDeviceLocation } from '../src/pages/CloudProfileAutoRows';
import { useCloudProfileEditor } from '../src/pages/useCloudProfileEditor';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import { installDom } from './helpers/transcriptAttachmentDom';

const base: CloudAccount = {
  accountId: 'acct_1', kordiId: 'maya', displayName: 'Maya', primaryEmail: 'maya@example.com',
  about: null, location: null, timeZone: 'America/Los_Angeles', website: null, birthday: null,
  locationMode: 'manual', timeZoneMode: 'automatic',
  avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: null, passwordSet: true,
};

function fakeLocation(status: string, calls: string[]): ProfileDeviceLocation {
  return {
    permission: async (request) => {
      calls.push(request ? 'ask' : 'check');
      return status;
    },
    city: async () => {
      calls.push('city');
      return 'Palo Alto, CA';
    },
    openSettings: () => { calls.push('settings'); },
  };
}

async function mount(account: CloudAccount, deviceLocation: ProfileDeviceLocation | null) {
  const installed = installDom();
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  host.className = 'app-cloud-account-profile';
  document.body.append(host);
  const root = createRoot(host);
  const sent: CloudProfileUpdateInput[] = [];
  let save: () => Promise<void> = async () => {};
  function Harness() {
    const editor = useCloudProfileEditor({ account, onUpdateProfile: async (input) => { sent.push(input); } });
    const { reset } = editor;
    useEffect(() => { reset(account); }, [reset]);
    save = editor.save;
    return createElement(CloudProfileAutoRows, { account, editor, id: (name: string) => `t-${name}`, deviceLocation });
  }
  await act(async () => root.render(createElement(Harness)));
  const typeInto = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(installed.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new installed.dom.window.Event('input', { bubbles: true }));
    });
  };
  const choose = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new installed.dom.window.Event('change', { bubbles: true }));
    });
  };
  return {
    sent,
    save: () => act(async () => { await save(); }),
    typeInto,
    choose,
    button: (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null,
    input: () => document.getElementById('t-location') as HTMLInputElement,
    select: () => document.getElementById('t-time-zone') as HTMLSelectElement,
    timeZoneAutomatic: () => Boolean(document.querySelector('.app-cloud-profile-auto-static')),
    unmount: async () => {
      await act(async () => root.unmount());
      installed.restore();
    },
  };
}

test('the arrow asks for location once, then fills the city in automatic mode', async () => {
  const calls: string[] = [];
  const view = await mount(base, fakeLocation('granted', calls));
  try {
    assert.equal(view.input().value, '');
    assert.equal(view.button('Automatic location on'), null);
    await act(async () => view.button('Set location automatically')!.click());
    assert.deepEqual(calls.filter((call) => call !== 'check'), ['ask', 'city']);
    assert.equal(view.input().value, 'Palo Alto, CA');
    assert.ok(view.button('Automatic location on'));
    await view.save();
    assert.deepEqual(view.sent, [{ displayName: 'Maya', location: 'Palo Alto, CA', locationMode: 'automatic' }]);
  } finally {
    await view.unmount();
  }
});

test('denied access keeps the field and shows one line to System Settings', async () => {
  const calls: string[] = [];
  const view = await mount({ ...base, location: 'Bay Area' }, fakeLocation('denied', calls));
  try {
    await act(async () => view.button('Set location automatically')!.click());
    assert.equal(view.input().value, 'Bay Area');
    assert.ok(!calls.includes('city'));
    const link = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Allow location in System Settings');
    assert.ok(link);
    await act(async () => link.click());
    assert.ok(calls.includes('settings'));
  } finally {
    await view.unmount();
  }
});

test('typing makes the location manual and the time zone menu leads with Automatic', async () => {
  const view = await mount({ ...base, location: 'Palo Alto, CA', locationMode: 'automatic' }, fakeLocation('granted', []));
  try {
    assert.equal(view.timeZoneAutomatic(), true);
    assert.equal(view.select().value, '');
    assert.match(view.select().options[0]!.textContent ?? '', /^Automatic · /);
    await view.typeInto(view.input(), 'Stanford');
    assert.equal(view.button('Automatic location on'), null);
    assert.ok(view.button('Set location automatically'));
    await view.choose(view.select(), 'Asia/Tokyo');
    assert.equal(view.timeZoneAutomatic(), false);
    await view.save();
    assert.deepEqual(view.sent, [{
      displayName: 'Maya', location: 'Stanford', timeZone: 'Asia/Tokyo', locationMode: 'manual', timeZoneMode: 'manual',
    }]);
  } finally {
    await view.unmount();
  }
});

test('without device location the row has no arrow', async () => {
  const view = await mount(base, null);
  try {
    assert.equal(view.button('Set location automatically'), null);
    assert.equal(view.input().placeholder, 'Add your location');
  } finally {
    await view.unmount();
  }
});
