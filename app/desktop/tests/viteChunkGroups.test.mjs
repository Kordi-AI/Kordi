import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import config from '../vite.config.js';

test('cloud features are split before the generic desktop features chunk', async () => {
  const resolvedConfig = typeof config === 'function'
    ? await config({ command: 'build', mode: 'production' })
    : config;
  const groups = resolvedConfig.build?.rolldownOptions?.output?.codeSplitting?.groups ?? [];
  const names = groups.map((group) => group.name);

  const cloudIndex = names.indexOf('cloud-features');
  const desktopIndex = names.indexOf('desktop-features');

  assert.notEqual(cloudIndex, -1, 'expected a dedicated cloud-features chunk group');
  assert.notEqual(desktopIndex, -1, 'expected the generic desktop-features chunk group');
  assert.ok(
    cloudIndex < desktopIndex,
    'cloud-features must be matched before desktop-features so it is split out',
  );
});

test('calling media is split before the generic vendor chunk', async () => {
  const resolvedConfig = typeof config === 'function'
    ? await config({ command: 'build', mode: 'production' })
    : config;
  const groups = resolvedConfig.build?.rolldownOptions?.output?.codeSplitting?.groups ?? [];
  const names = groups.map((group) => group.name);

  const callingMediaIndex = names.indexOf('calling-media');
  const vendorIndex = names.indexOf('vendor');

  assert.notEqual(callingMediaIndex, -1, 'expected a dedicated calling-media chunk group');
  assert.ok(
    callingMediaIndex < vendorIndex,
    'calling media must be matched before the generic vendor chunk',
  );
});

test('the emoji picker SDK is split before the generic vendor chunk', async () => {
  const resolvedConfig = typeof config === 'function'
    ? await config({ command: 'build', mode: 'production' })
    : config;
  const groups = resolvedConfig.build?.rolldownOptions?.output?.codeSplitting?.groups ?? [];
  const names = groups.map((group) => group.name);

  const expressiveMediaIndex = names.indexOf('expressive-media');
  const vendorIndex = names.indexOf('vendor');

  assert.notEqual(expressiveMediaIndex, -1, 'expected a dedicated expressive-media chunk group');
  assert.ok(
    expressiveMediaIndex < vendorIndex,
    'the emoji picker SDK must be matched before the generic vendor chunk',
  );
});

test('Vite development serves only with an explicit non-production API origin', async () => {
  const previous = process.env.VITE_KORDI_CLOUD_API_BASE;
  const previousProfile = process.env.VITE_KORDI_DEV_PROFILE;
  const previousAck = process.env.VITE_KORDI_PRODUCTION_DEBUG_ACK;
  try {
    delete process.env.VITE_KORDI_CLOUD_API_BASE;
    delete process.env.VITE_KORDI_DEV_PROFILE;
    delete process.env.VITE_KORDI_PRODUCTION_DEBUG_ACK;
    assert.throws(
      () => config({ command: 'serve', mode: 'endpoint-guard-test' }),
      /VITE_KORDI_CLOUD_API_BASE is required for development/i,
    );

    process.env.VITE_KORDI_CLOUD_API_BASE = 'https://kordi.ai:443/';
    assert.throws(
      () => config({ command: 'serve', mode: 'endpoint-guard-test' }),
      /production Cloud API is blocked in development/i,
    );

    process.env.VITE_KORDI_CLOUD_API_BASE = 'http://127.0.0.1:17081/';
    const resolved = await config({ command: 'serve', mode: 'endpoint-guard-test' });
    assert.ok(resolved.plugins?.length > 0);

    process.env.VITE_KORDI_CLOUD_API_BASE = 'https://kordi.ai';
    process.env.VITE_KORDI_DEV_PROFILE = 'operator';
    process.env.VITE_KORDI_PRODUCTION_DEBUG_ACK = '1';
    const operatorResolved = await config({ command: 'serve', mode: 'endpoint-guard-test' });
    assert.ok(operatorResolved.plugins?.length > 0);
  } finally {
    if (previous === undefined) delete process.env.VITE_KORDI_CLOUD_API_BASE;
    else process.env.VITE_KORDI_CLOUD_API_BASE = previous;
    if (previousProfile === undefined) delete process.env.VITE_KORDI_DEV_PROFILE;
    else process.env.VITE_KORDI_DEV_PROFILE = previousProfile;
    if (previousAck === undefined) delete process.env.VITE_KORDI_PRODUCTION_DEBUG_ACK;
    else process.env.VITE_KORDI_PRODUCTION_DEBUG_ACK = previousAck;
  }
});

test('the code viewer stays out of the startup chunks, split along dependencies', async () => {
  const resolvedConfig = typeof config === 'function'
    ? await config({ command: 'build', mode: 'production' })
    : config;
  const groups = resolvedConfig.build?.rolldownOptions?.output?.codeSplitting?.groups ?? [];
  const group = (name) => groups.find((entry) => entry.name === name);
  const matches = (entry, id) => (typeof entry.test === 'function' ? entry.test(id) : entry.test.test(id));
  const core = '/repo/node_modules/.pnpm/@codemirror+view@6/node_modules/@codemirror/view/dist/index.js';
  const lezer = '/repo/node_modules/.pnpm/@lezer+common@1/node_modules/@lezer/common/dist/index.js';
  const grammar = '/repo/node_modules/.pnpm/@lezer+python@1/node_modules/@lezer/python/dist/index.js';
  const language = '/repo/node_modules/.pnpm/@codemirror+lang-python@6/node_modules/@codemirror/lang-python/dist/index.js';
  const keyname = '/repo/node_modules/.pnpm/w3c-keyname@2/node_modules/w3c-keyname/index.js';
  const wrapper = '/repo/app/desktop/src/features/documents/viewers/CodeViewer.tsx';

  for (const id of [core, lezer, grammar, language]) assert.equal(matches(group('vendor'), id), false, `${id} is not in vendor`);
  assert.equal(matches(group('vendor'), keyname), true, 'the editor and the code viewer share w3c-keyname through vendor');
  assert.equal(matches(group('code-viewer'), core), true);
  assert.equal(matches(group('code-viewer'), lezer), true);
  assert.equal(matches(group('code-viewer'), grammar), false, 'grammars are not in the core chunk');
  assert.equal(matches(group('code-grammars'), grammar), true);
  assert.equal(matches(group('code-grammars'), language), true);
  assert.equal(matches(group('code-grammars'), lezer), false, 'the core is not in the grammars chunk');
  assert.equal(matches(group('desktop-features'), wrapper), false, 'the wrapper is the lazy entry, not a features module');
});
