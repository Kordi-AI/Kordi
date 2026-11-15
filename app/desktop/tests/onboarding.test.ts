import assert from 'node:assert/strict';
import test from 'node:test';
import { helpTourAvailable, helpTourEntry, helpTourStepAvailable, helpTourStepBody, helpTourSteps, helpTours } from '../src/features/onboarding/helpTourSteps';
import { navItems } from '../src/kordi-app/data/navigation';
import { HELP_TOUR_STEP_COUNT } from '../src/features/onboarding/helpProgress';
import { helpTourGeometry, helpTourRing } from '../src/features/onboarding/helpTourGeometry';
import { helpProgressKey, readHelpProgress, saveHelpProgress, markHelpWelcome } from '../src/features/onboarding/helpProgress';
import { normalizePermission, permissionAction } from '../src/features/onboarding/permissionAccess';
import { consumeHelpGrounding, consumeHelpGroundingScreen, hasHelpGrounding, requestHelpGrounding } from '../src/features/onboarding/helpNavigation';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); }, key: (index) => [...values.keys()][index] ?? null };
}

test('the workspace tour covers setup, cards, social, conversations, Factory, Digest, and access', () => {
  assert.equal(helpTourSteps.length, HELP_TOUR_STEP_COUNT);
  assert.equal(HELP_TOUR_STEP_COUNT, 30);
  for (const steps of Object.values(helpTours)) assert.ok(steps.length <= HELP_TOUR_STEP_COUNT);
  for (const target of ['settings-auth', 'grounding-topics', 'grounding-sharing', 'grounding-pair', 'grounding-room', 'grounding-room-people', 'grounding-room-topics', 'grounding-room-gallery', 'grounding-room-gallery-share', 'nav-contacts', 'nav-chats', 'nav-agent-chats', 'nav-agents', 'memory-import-run', 'memory-review', 'nav-digest', 'chat-export', 'help']) assert.ok(helpTourSteps.some((step) => step.target === target));
  assert.equal(new Set(helpTourSteps.map((step) => step.target)).size, helpTourSteps.length, 'each control is explained once');
  const sections = [...new Set(helpTourSteps.map((step) => step.section))];
  assert.deepEqual(sections, ['Tabs', 'Set up', 'Import memory', 'Cards', 'Build a card', 'Review and share', 'Meet people', 'Share your work', 'Help']);
  for (const section of sections) assert.ok(helpTourSteps.filter((step) => step.section === section).length <= 7);
  // Each section is one contiguous run, so the walkthrough never returns to a section it left.
  for (const section of sections) {
    const indices = helpTourSteps.flatMap((step, index) => step.section === section ? [index] : []);
    assert.equal(indices[indices.length - 1] - indices[0], indices.length - 1, section);
  }
});

test('the tour walks the rail first, imports memory before Grounding, and builds a card source by source', () => {
  const index = (target: string) => helpTourSteps.findIndex((step) => step.target === target);
  assert.deepEqual(helpTourSteps.slice(0, 5).map((step) => step.target), navItems.map((item) => `nav-${item.id}`));
  assert.deepEqual(helpTourSteps.slice(0, 5).map((step) => step.page), navItems.map((item) => item.id));
  const lastImport = Math.max(...helpTourSteps.flatMap((step, at) => step.settings === 'memory' ? [at] : []));
  const firstGrounding = helpTourSteps.findIndex((step) => step.target.startsWith('grounding'));
  assert.ok(lastImport < firstGrounding, 'memory import comes before any Grounding step');
  assert.ok(index('settings-auth') < index('settings-memory'));
  assert.ok(helpTourSteps[index('memory-review')].body.endsWith('Next, use them to build your card.'));
  const build = helpTourSteps.flatMap((step, at) => step.groundingScreen === 'build' ? [at] : []);
  assert.equal(build[build.length - 1] - build[0], build.length - 1, 'the Build steps are contiguous');
  assert.deepEqual(build.map((at) => helpTourSteps[at].target), ['grounding-memory', 'grounding-documents', 'grounding-connectors', 'grounding-device', 'grounding-links', 'grounding-notes', 'grounding-build']);
  assert.deepEqual(helpTourSteps.filter((step) => step.optional).map((step) => step.target), ['grounding-memory', 'grounding-connectors', 'grounding-device']);
  assert.equal(helpTourSteps[index('grounding-device')].desktopOnly, true);
  for (const target of ['grounding-pair', 'grounding-room', 'grounding-room-people', 'grounding-room-topics']) assert.ok(index(target) > index('grounding-sharing'), target);
  assert.deepEqual(['grounding-room-people', 'grounding-room-topics'].map((target) => helpTourSteps[index(target)].groundingScreen), ['room', 'room']);
  assert.ok(index('chat-export') > index('grounding-room-people') && index('chat-export') > index('grounding-room-topics'));
  // The Gallery opens "Share your work" in the same example room, right after its Topics step.
  const gallery = ['grounding-room-gallery', 'grounding-room-gallery-share'];
  assert.deepEqual(helpTourSteps.slice(index('grounding-room-topics') + 1, index('chat-export')).map((step) => step.target), gallery);
  assert.deepEqual(gallery.map((target) => [helpTourSteps[index(target)].groundingScreen, helpTourSteps[index(target)].section]), [['room', 'Share your work'], ['room', 'Share your work']]);
  assert.equal(helpTourSteps.find((step) => step.section === 'Share your work')?.target, 'grounding-room-gallery');
  assert.equal(index('chat-export'), index('help') - 1);
  assert.equal(helpTourSteps[index('chat-export')].page, 'chats');
  assert.equal(helpTourSteps[helpTourSteps.length - 1].target, 'help');
});

test('Help jumps start where each part of the walkthrough starts and the parts stay in order', () => {
  assert.deepEqual(helpTourEntry, { workspace: 'nav-contacts', imports: 'settings-memory', cards: 'grounding', grounding: 'grounding-pair' });
  for (const [id, target] of Object.entries(helpTourEntry) as Array<[keyof typeof helpTours, string]>) {
    assert.equal(helpTours[id][0].target, target, id);
    assert.ok(helpTours.workspace.some((step) => step.target === target), id);
  }
  assert.equal(helpTours.workspace, helpTourSteps);
  assert.equal(helpTourAvailable('imports', true), true);
  assert.equal(helpTours.cards.filter((step) => helpTourStepAvailable(step, true)).length, helpTours.cards.length - 1, 'the browser app skips the Mac sources');
  assert.equal(helpTourStepBody(helpTourSteps.find((step) => step.target === 'chat-export')!, true), 'Right-click a chat here or in Agent Chats and choose Export. The whole session, including agent steps, downloads as one file.');
});

test('progress is isolated by account and environment and tolerates damaged or unavailable storage', () => {
  const storage = memoryStorage();
  const first = helpProgressKey('user-a', 'http://127.0.0.1:18181');
  const second = helpProgressKey('user-b', 'http://127.0.0.1:18181');
  const otherEnvironment = helpProgressKey('user-a', 'http://127.0.0.1:17081');
  saveHelpProgress(first, { step: 3, completed: false, welcome: true }, storage);
  assert.equal(readHelpProgress(first, storage).step, 3);
  assert.deepEqual(readHelpProgress(second, storage), { step: 0, completed: false, welcome: false });
  assert.deepEqual(readHelpProgress(otherEnvironment, storage), { step: 0, completed: false, welcome: false });
  storage.setItem(first, '{');
  assert.equal(readHelpProgress(first, storage).step, 0);
  storage.setItem(first, '{"step":999,"completed":"true"}');
  assert.deepEqual(readHelpProgress(first, storage), { step: HELP_TOUR_STEP_COUNT - 1, completed: false, welcome: false });
  assert.equal(saveHelpProgress(first, { step: 1, completed: false, welcome: false }, null), false);
  assert.doesNotThrow(() => markHelpWelcome('test', 'loopback'));
});

test('permission recovery never offers another prompt for denied, restricted, or unknown access', () => {
  assert.equal(normalizePermission('default'), 'not-requested');
  assert.equal(normalizePermission('granted'), 'allowed');
  assert.equal(normalizePermission('new-native-value'), 'unknown');
  assert.equal(permissionAction('not-requested', true), 'Allow');
  assert.equal(permissionAction('denied', true), 'Open Settings');
  assert.equal(permissionAction('allowed', true), 'Open Settings');
  assert.equal(permissionAction('restricted', true), null);
  assert.equal(permissionAction('unavailable', true), null);
  assert.equal(permissionAction('unknown', true), 'Check again');
  assert.equal(permissionAction('denied', false), null);
});

test('Grounding navigation survives mounting and cannot cross into another account', () => {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: new EventTarget() });
  try {
    requestHelpGrounding('first-user');
    assert.equal(hasHelpGrounding('first-user'), true);
    assert.equal(hasHelpGrounding('first-user'), true, 'rendering twice must not consume the intent');
    assert.equal(consumeHelpGrounding('first-user'), true);
    assert.equal(hasHelpGrounding('first-user'), false);
    requestHelpGrounding('first-user');
    assert.equal(consumeHelpGrounding('second-user'), false);
    assert.equal(hasHelpGrounding('first-user'), false);
    requestHelpGrounding('first-user', 'build');
    assert.equal(consumeHelpGrounding('first-user'), true);
    assert.equal(consumeHelpGroundingScreen('first-user'), 'build');
    assert.equal(consumeHelpGroundingScreen('first-user'), null);
    requestHelpGrounding('first-user', 'card');
    assert.equal(consumeHelpGroundingScreen('second-user'), null);
    assert.equal(consumeHelpGroundingScreen('first-user'), null);
    requestHelpGrounding('first-user', 'room');
    assert.equal(consumeHelpGroundingScreen('first-user'), 'room');
  } finally { Object.assign(globalThis, { window: previous }); }
});


test('coachmarks stay next to targets and within small viewports', () => {
  for (const width of [390, 900, 1440]) {
    for (const left of [10, width - 42]) {
      for (const top of [20, 620]) {
        const position = helpTourGeometry({ left, top, width: 32, height: 32 }, { width, height: 740 }, { width: 320, height: 270 });
        assert.ok(position.left >= 12 && position.left + 320 <= width - 12);
        assert.ok(position.top >= 12 && position.top + 270 <= 740 - 12);
        assert.notEqual(position.side, 'none');
      }
    }
  }
});

test('coachmarks sit in open space beside the target instead of across the window', () => {
  const viewport = { width: 1440, height: 900 };
  // A wide card section with no room on its right: the panel goes below it, aligned with its start edge.
  const section = helpTourGeometry({ left: 527, top: 197, width: 830, height: 114 }, viewport, { width: 320, height: 207 });
  assert.equal(section.side, 'bottom');
  assert.equal(section.left, 527);
  assert.equal(section.top, 197 + 114 + 16);
  assert.equal(section.arrow, 40);
  // A small button with room on its right keeps the panel right next to it.
  const button = helpTourGeometry({ left: 821, top: 573, width: 86, height: 42 }, viewport, { width: 320, height: 228 });
  assert.equal(button.side, 'right');
  assert.equal(button.left, 821 + 86 + 16);
  // A target at the right edge with room below never sends the panel to the far left.
  const edge = helpTourGeometry({ left: 1100, top: 100, width: 320, height: 60 }, viewport, { width: 320, height: 200 });
  assert.equal(edge.side, 'bottom');
  assert.ok(edge.left >= 1100 - 320);
  // Left of the target only when there is no room to the right or below.
  const low = helpTourGeometry({ left: 1200, top: 760, width: 200, height: 100 }, viewport, { width: 320, height: 200 });
  assert.equal(low.side, 'left');
  assert.equal(low.left, 1200 - 16 - 320);
});

test('the tour ring stays centered on targets near the window edge', () => {
  const viewport = { width: 1280, height: 720 };
  const whole = { left: 0, top: 0, right: 1280, bottom: 720 };
  const center = (ring: { left: number; top: number; width: number; height: number }) => [ring.left + ring.width / 2, ring.top + ring.height / 2];
  // A native rail icon 4px from the window edge: the pad shrinks evenly instead of only on the left.
  const rail = helpTourRing({ left: 4, top: 170, right: 36, bottom: 202 }, whole, viewport)!;
  assert.deepEqual(rail, { left: 0, top: 166, width: 40, height: 40 });
  assert.deepEqual(center(rail), [20, 186]);
  // With room on every side the ring keeps its full 5px pad.
  assert.deepEqual(helpTourRing({ left: 100, top: 100, right: 132, bottom: 132 }, whole, viewport), { left: 95, top: 95, width: 42, height: 42 });
  // A clipping container close to the target trims the pad evenly too.
  const list = { left: 60, top: 40, right: 360, bottom: 700 };
  assert.deepEqual(center(helpTourRing({ left: 62, top: 300, right: 358, bottom: 340 }, list, viewport)!), [210, 320]);
  // A target cut off by a scrolling list falls back to its visible part.
  assert.deepEqual(helpTourRing({ left: 80, top: 680, right: 340, bottom: 760 }, list, viewport), { left: 75, top: 675, width: 270, height: 25 });
  assert.equal(helpTourRing({ left: 80, top: 720, right: 340, bottom: 760 }, list, viewport), null);
});
