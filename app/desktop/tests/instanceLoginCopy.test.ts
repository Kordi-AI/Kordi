import assert from 'node:assert/strict';
import test from 'node:test';
import { loginHeading, loginSubtitle } from '../src/kordi-app/cloud/cloudLoginMessages';

test('instance welcome copy comes from the selected ops profile and development keeps its current text', (t) => {
  const original = Reflect.get(globalThis, '__KORDI_DISTRIBUTION__');
  t.after(() => Reflect.set(globalThis, '__KORDI_DISTRIBUTION__', original));
  Reflect.set(globalThis, '__KORDI_DISTRIBUTION__', { loginPage: {
    title: 'Welcome to Research Staging', subtitle: 'Approved testers only.',
    signupTitle: 'Join Research Staging', signupSubtitle: 'Verify your approved email.',
  } });
  assert.equal(loginHeading(), 'Welcome to Research Staging');
  assert.equal(loginSubtitle(), 'Approved testers only.');
  Reflect.set(globalThis, '__KORDI_DISTRIBUTION__', null);
  assert.equal(loginHeading(), 'Welcome to Kordi');
  assert.equal(loginSubtitle(), 'Building Next-generation Supercollaboration');
});
