import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CompanionSourceView } from '../src/features/documents/CompanionSourceView';
import { COMPANION_DOCUMENT_OPEN_EVENT, openArtifactInSidePanel, type CompanionDocument } from '../src/features/documents/companionDocument';
import type { DocumentResponse } from '../src/features/documents/documentShareTypes';
import { documentTitleFor, resetDocumentTitlesForTests } from '../src/features/documents/documentTitles';
import type { SessionArtifact } from '../src/kordi-app/types';
import { ArtifactCard, ArtifactThumbnailView } from '../src/pages/ArtifactCard';
import { readStoredArtifactLayout } from '../src/pages/artifactLayoutPreference';
import { ArtifactListRow } from '../src/pages/ArtifactListRow';
import { artifactThumbnailKey, loadArtifactThumbnail, THUMBNAIL_SOURCE_CHARS } from '../src/pages/artifactThumbnail';
import { openArtifactExternally } from '../src/features/documents/openArtifactExternally';
import { setArtifactFileLoadersForPreview, setArtifactImageLoaderForPreview, setArtifactPreviewLoaderForPreview } from '../src/features/documents/artifactPreviewLoader';

const doc = (id: string, path: string, extra: Partial<SessionArtifact> = {}): SessionArtifact => ({
  id, path, name: path.split('/').pop() ?? path, kind: 'document', category: 'artifact', summary: 'Created', ...extra,
});

const api = {
  getDocument: async (attachmentId: string) => ({
    attachmentId,
    title: 'Launch plan',
    blocks: [{ id: 'b1', source: '# Launch plan', html: '' }, { id: 'b2', source: 'Ship on Friday.', html: '' }],
  }) as unknown as DocumentResponse,
  getDocumentRaw: async () => '<h1>Pricing</h1>'.padEnd(THUMBNAIL_SOURCE_CHARS + 50, ' '),
};

test('the Artifacts tab starts in cards unless the list was chosen', () => {
  assert.equal(readStoredArtifactLayout({ getItem: () => null }), 'cards');
  assert.equal(readStoredArtifactLayout({ getItem: () => 'list' }), 'list');
  assert.equal(readStoredArtifactLayout({ getItem: () => 'grid' }), 'cards');
  assert.equal(readStoredArtifactLayout({ getItem: () => { throw new Error('blocked'); } }), 'cards');
});

test('a cloud document thumbnail reads its blocks, an HTML one its raw page, and both stay short', async () => {
  resetDocumentTitlesForTests();
  const markdown = await loadArtifactThumbnail(doc('a', 'notes/plan.md', { attachmentId: 'att_plan' }), { isNativeShell: false, api });
  assert.deepEqual(markdown, { kind: 'markdown', source: '# Launch plan\n\nShip on Friday.' });
  assert.equal(documentTitleFor('att_plan'), 'Launch plan', 'the title is remembered for the card label');

  const html = await loadArtifactThumbnail(doc('b', 'site/pricing.html', { attachmentId: 'att_page' }), { isNativeShell: false, api });
  assert.equal(html?.kind, 'html');
  assert.equal(html?.source.length, THUMBNAIL_SOURCE_CHARS);
});

test('images and files with nothing to read show the file-type mark', async () => {
  assert.equal(await loadArtifactThumbnail(doc('c', 'shots/hero.png', { kind: 'file' }), { isNativeShell: false, api }), null);
  // Not the desktop app and no cloud copy: nothing to read.
  assert.equal(await loadArtifactThumbnail(doc('d', 'src/app.ts', { kind: 'code' }), { isNativeShell: false, api: null }), null);
  const failing = { getDocument: async () => { throw new Error('offline'); }, getDocumentRaw: async () => { throw new Error('offline'); } };
  assert.equal(await loadArtifactThumbnail(doc('e', 'notes/plan.md', { attachmentId: 'att_x' }), { isNativeShell: false, api: failing }), null);
});

test('a thumbnail reloads after an edit, and a pinned file ignores the project root', () => {
  const artifact = doc('a', 'notes/plan.md', { timeLabel: '10:24' });
  assert.notEqual(artifactThumbnailKey(artifact), artifactThumbnailKey({ ...artifact, timeLabel: '10:31' }));
  assert.notEqual(artifactThumbnailKey(artifact), artifactThumbnailKey({ ...artifact, live: true }));
  assert.equal(artifactThumbnailKey({ ...artifact, pinned: true }, '/root/a'), artifactThumbnailKey({ ...artifact, pinned: true }, '/root/b'));
});

test('a card shows the title, the type pill, the creator and time, and Live for a file being written', () => {
  const markup = renderToStaticMarkup(createElement(ArtifactCard, {
    artifact: doc('a', 'notes/launch-brief.md', { timeLabel: '10:24', createdByAccountId: 'acct_priya' }),
    isActive: false,
    participants: [{ id: 'acct_priya', name: 'Priya Nair', kind: 'human', role: 'member' }],
    thumbnailContext: { isNativeShell: false, api: null },
    onOpen: () => {},
    fetchTitle: async () => ({ title: '' }),
  }));
  assert.match(markup, /data-artifact-card-title=""[^>]*>launch-brief\.md</);
  assert.match(markup, />MD</);
  assert.match(markup, /Priya Nair[^]*10:24/);
  assert.doesNotMatch(markup, /aria-current/, 'nothing is marked before it is opened');

  const live = renderToStaticMarkup(createElement(ArtifactCard, {
    artifact: doc('b', 'Untitled', { live: true, timeLabel: '10:30' }),
    isActive: true,
    participants: [],
    thumbnailContext: { isNativeShell: false, api: null },
    onOpen: () => {},
    fetchTitle: async () => ({ title: '' }),
  }));
  assert.match(live, />Live</);
  assert.doesNotMatch(live, /10:30/, 'Live replaces the time');
  assert.doesNotMatch(live, /app-artifact-card-type/, 'no type pill for a bare name');
  assert.match(live, /aria-current="true"/);
});

test('code and table thumbnails keep only the first lines and columns', () => {
  const code = renderToStaticMarkup(createElement(ArtifactThumbnailView, {
    thumbnail: { kind: 'source', source: Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n') }, path: 'src/a.ts',
  }));
  // The page measures itself before it draws, so server markup is the empty frame.
  assert.match(code, /app-artifact-card-code/);
  const html = renderToStaticMarkup(createElement(ArtifactThumbnailView, { thumbnail: { kind: 'html', source: '<script>alert(1)</script>' }, path: 'a.html' }));
  assert.doesNotMatch(html, /alert/, 'nothing renders before the frame has a size');
});

test('open in default app uses a fresh copy of a shared document, and the project file otherwise', async () => {
  const copies: Array<[string, string]> = [];
  const opened: Array<[string, string | null]> = [];
  const deps = {
    api,
    openCopy: async (name: string, contents: string) => { copies.push([name, contents]); },
    open: async (path: string, baseRoot: string | null) => { opened.push([path, baseRoot]); },
  };
  await openArtifactExternally(doc('a', 'notes/plan.md', { attachmentId: 'att_plan' }), '/project', deps);
  assert.deepEqual(copies, [['plan.md', '# Launch plan\n\nShip on Friday.']], 'the cloud copy carries everyone\'s edits');
  assert.deepEqual(opened, []);

  await openArtifactExternally(doc('b', 'src/app.ts', { kind: 'code' }), '/project', deps);
  await openArtifactExternally(doc('c', '/abs/pinned.md', { pinned: true }), '/project', deps);
  assert.deepEqual(opened, [['src/app.ts', '/project'], ['/abs/pinned.md', null]], 'a pinned file ignores the project root');

  const offline = { ...deps, api: { getDocument: async () => { throw new Error('offline'); }, getDocumentRaw: async () => { throw new Error('offline'); } } };
  await openArtifactExternally(doc('d', 'notes/draft.md', { attachmentId: 'att_draft' }), '/project', offline);
  assert.deepEqual(opened.at(-1), ['notes/draft.md', '/project'], 'without the server, the project file opens');

  await assert.rejects(openArtifactExternally(doc('e', 'missing.ts', { kind: 'code' }), null, {
    ...deps, open: async () => { throw new Error('Artifact file not found'); },
  }));
});

test('the open arrow shows on rows and cards only where a file can be opened', () => {
  const artifact = doc('a', 'notes/plan.md', { timeLabel: '10:24' });
  const rowWith = renderToStaticMarkup(createElement(ArtifactListRow, { artifact, location: 'notes', isActive: false, participants: [], onSelect: () => {}, onOpenExternal: () => {}, fetchTitle: async () => ({ title: '' }) }));
  assert.match(rowWith, /data-artifact-open-external=""[^>]*aria-label="Open plan\.md in its default app"/);
  // The arrow sits right after the name, before the detail.
  assert.match(rowWith, /data-artifact-row-title=""[^>]*>plan\.md<\/span><\/button><button[^>]*data-artifact-open-external=""[^]*data-artifact-row-meta=""/);
  const rowWithout = renderToStaticMarkup(createElement(ArtifactListRow, { artifact, location: 'notes', isActive: false, participants: [], onSelect: () => {}, fetchTitle: async () => ({ title: '' }) }));
  assert.doesNotMatch(rowWithout, /data-artifact-open-external/);
  // The row is one line: the name and its detail sit side by side.
  assert.match(rowWithout, /data-artifact-row-title=""[^>]*>plan\.md<\/span><\/button><span data-artifact-row-meta=""[^>]*>notes · Created · 10:24</);

  const card = renderToStaticMarkup(createElement(ArtifactCard, {
    artifact, isActive: false, participants: [], thumbnailContext: { isNativeShell: true, api: null }, onOpen: () => {}, onOpenExternal: () => {}, fetchTitle: async () => ({ title: '' }),
  }));
  assert.match(card, /class="app-artifact-card-open"[^>]*aria-label="Open plan\.md in its default app"/);
});

test('every artifact opens in the side panel: documents in the reader, other files in the source view', () => {
  const requests: CompanionDocument[] = [];
  const listen = (event: Event) => { requests.push((event as CustomEvent<CompanionDocument>).detail); event.preventDefault(); };
  const target = new EventTarget();
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = Object.assign(target, { CustomEvent });
  target.addEventListener(COMPANION_DOCUMENT_OPEN_EVENT, listen);
  try {
    assert.equal(openArtifactInSidePanel(doc('a', 'notes/plan.md'), '/project'), true);
    assert.equal(openArtifactInSidePanel(doc('b', 'src/app.ts', { kind: 'code' }), '/project'), true);
    assert.equal(openArtifactInSidePanel(doc('c', 'data/prices.csv', { kind: 'file' })), true);
  } finally {
    target.removeEventListener(COMPANION_DOCUMENT_OPEN_EVENT, listen);
    (globalThis as { window?: unknown }).window = previousWindow;
  }
  assert.deepEqual(requests.map((request) => [request.artifact.path, Boolean(request.sourceView), request.previewBaseRoot]), [
    ['notes/plan.md', false, '/project'],
    ['src/app.ts', true, '/project'],
    ['data/prices.csv', true, null],
  ]);
});

test('the source view names the type plainly and offers a way out for files it cannot show', () => {
  const preview = (path: string) => ({ path, truncated: false, lines: [{ number: 1, text: 'x' }] });
  const view = (props: Parameters<typeof CompanionSourceView>[0]) => renderToStaticMarkup(createElement(CompanionSourceView, props));
  assert.match(view({ preview: preview('src/app.ts'), onReload: () => {} }), /app-document-source-info">TypeScript · 1 line</);
  assert.match(view({ preview: preview('data/prices.csv'), onReload: () => {} }), />CSV · 0 rows</);
  assert.match(view({ preview: preview('notes/a.txt'), onReload: () => {} }), />Plain text · 1 line</);
  const withOpen = view({ preview: preview('src/app.py'), onReload: () => {}, onOpenExternal: () => {} });
  assert.match(withOpen, />Python · 1 line</);
  assert.match(withOpen, />Copy</);
  assert.match(withOpen, />Open in default app</);
  assert.doesNotMatch(view({ preview: preview('src/app.py'), onReload: () => {} }), /Open in default app/, 'only where the file can be reached');

  // A PDF draws in WebKit's own viewer; a document Quick Look understands gets a file card.
  const pdf = view({ preview: null, pdf: { src: 'blob:pdf', sizeBytes: 2_200_000 }, path: 'decks/pricing.pdf', onReload: () => {}, onQuickLook: () => {}, onOpenExternal: () => {} });
  assert.match(pdf, /<iframe class="app-pdf-viewer" data-pdf-viewer="" title="pricing\.pdf" src="blob:pdf">/);
  assert.match(pdf, /app-document-source-info">PDF · 2\.1 MB</);
  assert.match(pdf, />Quick Look</);
  const unreadablePdf = view({ preview: null, path: 'decks/pricing.pdf', onReload: () => {}, onOpenExternal: () => {} });
  assert.match(unreadablePdf, /This file is unavailable on this device\./);
  assert.match(unreadablePdf, />Open in default app</);
  const card = view({ preview: null, thumbnail: { src: 'data:image/png;base64,AAAA', sizeBytes: 86_016 }, path: 'docs/q4-plan.docx', onReload: () => {}, onQuickLook: () => {}, onOpenExternal: () => {} });
  assert.match(card, /data-file-card=""/);
  assert.match(card, /class="app-file-card-thumbnail" src="data:image\/png;base64,AAAA"/);
  assert.match(card, />q4-plan\.docx</);
  assert.match(card, />Word document · 84 KB</);
  assert.match(card, /app-file-card-primary"[^>]*>.*Quick Look/);
  const webCard = view({ preview: null, path: 'media/demo.mov', onReload: () => {} });
  assert.match(webCard, />Video</);
  assert.match(webCard, /Open this file in the Kordi desktop app\./, 'outside the desktop app there is no Quick Look');

  // Images and tables get their own viewers that fill the panel.
  const image = view({ preview: null, image: { src: 'data:image/png;base64,AAAA', sizeBytes: 2048 }, path: 'shots/hero.png', onReload: () => {} });
  assert.match(image, /data-image-viewer=""/);
  assert.match(image, /PNG image · 2 KB/);
  const table = view({ preview: { path: 'data/prices.csv', truncated: false, lines: [{ number: 1, text: 'Plan,Seats' }, { number: 2, text: 'Free,3' }, { number: 3, text: 'Team,25' }] }, onReload: () => {} });
  assert.match(table, /data-table-viewer=""/);
  assert.match(table, /CSV · 2 rows/);
  assert.match(table, /aria-pressed="true"[^>]*>Table</);
  assert.match(table, /<td class="app-table-viewer-numeric">25<\/td>/, 'numeric columns align right');
  const missing = view({ preview: null, path: 'src/gone.ts', onReload: () => {} });
  assert.match(missing, /This file is unavailable on this device\./);
  assert.match(missing, />Retry</);
});

test('images, PDFs, and documents get Quick Look thumbnails, and an image falls back to its own bytes', async () => {
  setArtifactPreviewLoaderForPreview(async ({ path }) => ({ path, truncated: false, lines: [{ number: 1, text: 'x' }] }));
  setArtifactImageLoaderForPreview(async () => ({ src: 'data:image/png;base64,IMAGE', sizeBytes: 10 }));
  setArtifactFileLoadersForPreview({
    thumbnail: async ({ path }) => {
      if (path.endsWith('.png')) throw new Error('Quick Look could not draw it');
      return { src: `data:image/png;base64,${path.endsWith('.pdf') ? 'PDF' : 'DOC'}`, sizeBytes: 1 };
    },
  });
  try {
    const load = (path: string) => loadArtifactThumbnail(doc(path, path, { kind: 'file' }), { isNativeShell: false, api: null });
    assert.deepEqual(await load('decks/pricing.pdf'), { kind: 'image', source: 'data:image/png;base64,PDF' });
    assert.deepEqual(await load('docs/plan.docx'), { kind: 'image', source: 'data:image/png;base64,DOC' });
    assert.deepEqual(await load('shots/hero.png'), { kind: 'image', source: 'data:image/png;base64,IMAGE' });
  } finally {
    setArtifactPreviewLoaderForPreview(undefined);
    setArtifactImageLoaderForPreview(undefined);
    setArtifactFileLoadersForPreview({});
  }
});
