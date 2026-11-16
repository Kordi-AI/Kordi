import { useEffect, useState, useSyncExternalStore } from 'react';
import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import type { HelpGroundingScreen } from '@/features/onboarding/helpNavigation';
import { useHelpTourLocation } from '@/features/onboarding/helpTourSession';
import { createCommonGroundClient } from './client';
import { CommonGroundStore } from './store';
import { BuildScreen } from './BuildScreen';
import { CardScreen } from './CardScreen';
import { HomeScreen } from './HomeScreen';
import { ResultsScreen } from './ResultsScreen';
import { WalletShell } from './WalletShell';
import type { CgHost } from './host';
import type { CgGalleryItem, CgGalleryList, CgPerson, CgResults, CgRoom, CgRoomTab } from './types';

const profile = { profileId: 'tour-example', kind: 'work' as const, name: 'Example card', focus: 'Designing useful apps', position: 0, hasCard: true, sharing: false, builtAt: null, topicCount: 4, design: null, icon: null,
  sources: { memory: false, connectors: [], device: [], agents: false, documents: ['tour-document'], links: '', notes: 'I design accessible apps. I enjoy hiking, can help with interface design, and would like feedback on a new app.' } };
const owner = { card: { workingOn: ['An accessible app'], interests: ['Hiking'], canHelp: ['Interface design'], lookingFor: ['Feedback on an app'], hidden: [], revision: 1, builtAt: null }, sharing: false, build: { status: 'idle' as const, errorCode: null }, profile };
const self = { accountId: 'tour-example', name: 'Alex · Example', avatarUrl: null };

// A fictional room, so every account sees people and shared topics.
const ROOM = '2468';
const person = (name: string): CgPerson => ({ accountId: `tour-${name.split(' ')[0].toLowerCase()}`, name, avatarUrl: null });
const [sam, noor, leo, ana, kenji] = ['Sam Rivera', 'Noor Haddad', 'Leo Martins', 'Ana Kowalski', 'Kenji Mori'].map(person);
const accessible = { label: 'Accessible interfaces', people: [self, sam, noor, ana] };
const prototypes = { label: 'Hackathon prototypes', people: [self, noor, leo, kenji] };
const room: CgRoom = { roomId: 'tour-room', code: ROOM, name: 'Hackathon room · Example', openedByYou: false, expiresAt: '2099-01-01T00:00:00Z', open: true, kind: 'work', profileId: profile.profileId, members: [sam, noor, leo, ana, kenji] };
const results: CgResults = { status: 'ready', profileId: profile.profileId, suggestion: accessible, groups: [],
  people: [
    { person: sam, score: 86, headline: 'Builds design tools for screen reader users' },
    { person: noor, score: 78, headline: 'Looking for a designer for a hackathon project' },
    { person: leo, score: 64, headline: 'Prototypes apps with small language models' },
    { person: ana, score: 57, headline: 'Studies how people learn new interfaces' },
    { person: kenji, score: 42, headline: 'Plans weekend hikes and outdoor apps' },
  ],
  topics: [accessible, prototypes, { label: 'Hiking', people: [self, kenji, sam] }] };
// What the room shared to its Gallery; text previews draw the cards, so no file is ever read.
const shared = (n: number, sharer: CgPerson, title: string, fileName: string, contentType: string, topic: string | null, commentCount: number, preview: string): CgGalleryItem => (
  { itemId: `tour-item-${n}`, attachmentId: `tour-file-${n}`, title, fileName, contentType, sizeBytes: preview.length, topic, preview, person: sharer, mine: false, commentCount, createdAt: '2026-01-01T00:00:00Z' });
const gallery: CgGalleryList = { canShare: true, items: [
  shared(1, sam, 'Screen reader design notes', 'design-notes.md', 'text/markdown', accessible.label, 2, '# Screen reader design notes\n\n- Label every control\n- Keep focus order the same as reading order\n- Announce changes after a save'),
  shared(2, noor, 'Demo script', 'demo-script.md', 'text/markdown', prototypes.label, 1, '# Demo script\n\n1. Open the app\n2. Build a card\n3. Join the room\n4. Finish in three minutes'),
  shared(3, leo, 'Model latency by device', 'latency.csv', 'text/csv', prototypes.label, 0, 'Device,Model,Latency\nLaptop,Small,120 ms\nPhone,Small,340 ms\nLaptop,Medium,410 ms'),
  shared(4, ana, 'Usability study tasks', 'study-tasks.json', 'application/json', null, 0, '{\n  "tasks": ["Find settings", "Add a contact", "Share a card"]\n}'),
] };
const ROOM_TABS: Record<string, CgRoomTab> = { 'grounding-room-topics': 'topics', 'grounding-room-gallery': 'gallery', 'grounding-room-gallery-share': 'gallery' };

/** A disposable, disconnected store: example controls can never write to the account. */
function exampleStore() {
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  // Reads answer with the example; everything else fails, so nothing reaches the account.
  const client = createCommonGroundClient({ token: () => Promise.resolve('tour-example'), fetchImpl: () => (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const read = !init?.method || init.method === 'GET';
    if (read && url.includes('/documents')) return json({ documents: [{ attachmentId: 'tour-document', title: 'App design notes · Example', updatedAt: '2026-01-01T00:00:00Z', sizeBytes: 240 }] });
    if (read && url.endsWith(`/rooms/${ROOM}/gallery`)) return json(gallery);
    return Promise.reject(new Error('Example only. Close the tour to use your own cards.'));
  } });
  const store = new CommonGroundStore(client, { profiles: true });
  const { support, gallery: empty } = store.getSnapshot();
  store.set({ loaded: true, owner, profiles: [profile], profileId: profile.profileId, rooms: { [ROOM]: room }, results: { [ROOM]: results },
    support: { ...support, gallery: true }, gallery: { ...empty, lists: { [ROOM]: gallery } } });
  return store;
}
// In-memory sources so the example Build screen shows every group; nothing reaches the Mac or the network.
const desktop = !isBrowserAppRuntime();
const host: CgHost = { self, profiles: true, sources: true, memoryAvailable: true, openChat: () => undefined, acceptRequest: () => Promise.resolve(), contactsChanged: () => undefined, openGroup: () => undefined, openUrl: () => undefined,
  connectors: { client: { list: () => Promise.resolve({ states: [], agents: [] }), disconnect: () => Promise.resolve() }, openSettings: () => undefined },
  agentFiles: desktop ? () => Promise.resolve([{ label: 'AGENTS.md', text: 'Use TypeScript for app code.' }, { label: 'CLAUDE.md', text: 'Keep explanations short.' }]) : null,
  device: desktop ? { status: () => Promise.resolve({ calendar: 'not_determined', reminders: 'not_determined' }), request: () => Promise.resolve({ calendar: 'not_determined', reminders: 'not_determined' }), titles: () => Promise.resolve([]) } : null };

export function HelpGroundingDemo({ screen }: { screen: HelpGroundingScreen }) {
  const [store] = useState(exampleStore);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // Each room step opens its own list; the key remounts the room so going back opens it again.
  const tab = ROOM_TABS[useHelpTourLocation()?.target ?? ''] ?? 'people';
  useEffect(() => { store.set({ stack: [screen === 'room' ? { name: 'results', code: ROOM } : { name: screen }] }); }, [screen, store]);
  const page = screen === 'build' || screen === 'room';
  return <section aria-label="Grounding example" className="cg-page is-wallet" data-help-grounding-card="built" data-help-grounding-social="ready" data-help-demo="grounding">
    <div className="help-example-label" role="note"><strong>Example data</strong><span>A preview for this tour. Nothing is saved or shared.</span></div>
    <fieldset disabled className="help-example-content" aria-label="Example card controls">
      {page ? <div className="cg-scroll"><div className="cg-body">{screen === 'build' ? <BuildScreen state={state} store={store} host={host} /> : <ResultsScreen key={tab} code={ROOM} initialTab={tab} state={state} store={store} host={host} />}</div></div> : <WalletShell state={state} store={store} owner={host.self} title={screen === 'card' ? 'Example card' : 'Grounding'}>
        {screen === 'card' ? <CardScreen state={state} store={store} /> : <HomeScreen state={state} store={store} />}
      </WalletShell>}
    </fieldset>
  </section>;
}
