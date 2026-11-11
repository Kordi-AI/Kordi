import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROFILE_CITY_INTERVAL_MS,
  profileCityDue,
  profileDeviceUpdate,
} from '../src/features/cloud/profileDeviceSync';
import { cloudProfileFieldDraft, cloudProfileSaveInput } from '../src/pages/cloudProfileDraft';
import type { CloudAccount } from '../src/features/cloud/cloudIdentityTypes';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const automatic = {
  timeZone: 'America/Los_Angeles',
  location: 'Palo Alto, CA',
  timeZoneMode: 'automatic',
  locationMode: 'automatic',
} as const;

test('a device sends values it saw change and the account does not hold', () => {
  const memory = { timeZone: 'America/Los_Angeles', location: 'Palo Alto, CA' };
  const moved = profileDeviceUpdate(automatic, { timeZone: 'Asia/Riyadh', location: 'Thuwal, Saudi Arabia' }, memory);
  assert.deepEqual(moved.body, { timeZone: 'Asia/Riyadh', location: 'Thuwal, Saudi Arabia' });
  assert.deepEqual(moved.memory, { timeZone: 'Asia/Riyadh', location: 'Thuwal, Saudi Arabia' });

  const still = profileDeviceUpdate(automatic, { timeZone: 'America/Los_Angeles', location: 'Palo Alto, CA' }, memory);
  assert.deepEqual(still.body, {});
});

test('a device that did not move leaves another device\'s value alone', () => {
  // The iPhone reported Thuwal; this Mac still sees Palo Alto as before.
  const account = { ...automatic, timeZone: 'Asia/Riyadh', location: 'Thuwal, Saudi Arabia' };
  const update = profileDeviceUpdate(account, { timeZone: 'America/Los_Angeles', location: 'Palo Alto, CA' }, {
    timeZone: 'America/Los_Angeles',
    location: 'Palo Alto, CA',
  });
  assert.deepEqual(update.body, {});
});

test('a first observation only fills an empty field', () => {
  const empty = { ...automatic, timeZone: null, location: null };
  assert.deepEqual(
    profileDeviceUpdate(empty, { timeZone: 'Europe/Lisbon', location: 'Lisbon, Portugal' }, {}).body,
    { timeZone: 'Europe/Lisbon', location: 'Lisbon, Portugal' },
  );
  const filled = profileDeviceUpdate(automatic, { timeZone: 'Europe/Lisbon', location: 'Lisbon, Portugal' }, {});
  assert.deepEqual(filled.body, {});
  assert.deepEqual(filled.memory, { timeZone: 'Europe/Lisbon', location: 'Lisbon, Portugal' });
});

test('manual fields and older servers get nothing', () => {
  const manual = { ...automatic, timeZoneMode: 'manual', locationMode: 'manual' } as const;
  assert.deepEqual(profileDeviceUpdate(manual, { timeZone: 'Asia/Riyadh', location: 'Thuwal, Saudi Arabia' }, {}).body, {});
  const older = { timeZone: null, location: null };
  assert.deepEqual(profileDeviceUpdate(older, { timeZone: 'Asia/Riyadh' }, {}).body, {});
  assert.deepEqual(profileDeviceUpdate(automatic, { timeZone: '  ', location: null }, {}).body, {});
});

test('the city is looked up at launch and then at most every half hour', () => {
  const now = 1_000_000_000;
  assert.equal(profileCityDue({ locationMode: 'manual' }, {}, now, true), false);
  assert.equal(profileCityDue({ locationMode: 'automatic' }, {}, now), true);
  const recent = { locationCheckedAt: now - 60_000 };
  assert.equal(profileCityDue({ locationMode: 'automatic' }, recent, now), false);
  assert.equal(profileCityDue({ locationMode: 'automatic' }, recent, now, true), true);
  assert.equal(profileCityDue({ locationMode: 'automatic' }, { locationCheckedAt: now - PROFILE_CITY_INTERVAL_MS }, now), true);
  assert.equal(profileCityDue({ locationMode: 'automatic' }, { locationCheckedAt: now + 60_000 }, now), true, 'a clock moved back');
});

const account: CloudAccount = {
  accountId: 'acct_1', kordiId: 'maya', displayName: 'Maya', primaryEmail: 'maya@example.com',
  about: null, location: 'Palo Alto, CA', timeZone: 'America/Los_Angeles', website: null, birthday: null,
  locationMode: 'automatic', timeZoneMode: 'automatic',
  avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: null, passwordSet: true,
};

test('the editor never sends values the devices own', () => {
  const opened = cloudProfileFieldDraft(account);
  // Another device moved the account while the editor was open.
  const moved = { ...account, location: 'Thuwal, Saudi Arabia', timeZone: 'Asia/Riyadh' };
  const input = cloudProfileSaveInput({
    displayNameDraft: 'Maya',
    avatarMutationDraft: null,
    fieldDraft: { ...opened, about: 'Hi' },
    savedFields: cloudProfileFieldDraft(moved),
  });
  assert.deepEqual(input, { displayName: 'Maya', about: 'Hi' });
});

test('typing a location or picking a zone sends the value with a manual mode', () => {
  const saved = cloudProfileFieldDraft(account);
  const input = cloudProfileSaveInput({
    displayNameDraft: 'Maya',
    avatarMutationDraft: null,
    fieldDraft: { ...saved, location: 'Bay Area', locationMode: 'manual', timeZone: 'Asia/Tokyo', timeZoneMode: 'manual' },
    savedFields: saved,
  });
  assert.deepEqual(input, {
    displayName: 'Maya', location: 'Bay Area', locationMode: 'manual', timeZone: 'Asia/Tokyo', timeZoneMode: 'manual',
  });
});

test('older servers without modes map a stored zone to manual and none to automatic', () => {
  const older = { ...account, locationMode: undefined, timeZoneMode: undefined };
  assert.equal(cloudProfileFieldDraft(older).timeZoneMode, 'manual');
  assert.equal(cloudProfileFieldDraft(older).locationMode, 'manual');
  assert.equal(cloudProfileFieldDraft({ ...older, timeZone: null }).timeZoneMode, 'automatic');
});
