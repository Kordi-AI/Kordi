import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import { DocumentReader } from '../src/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const uploaded = `kordi-avatar://uploaded/ava_${'a'.repeat(32)}`;

for (const scenario of ['own missing avatar', 'another author', 'anonymous author', 'existing document avatar'] as const) {
  test(`document People card: ${scenario}`, async () => {
    await withJsdomRoot(async (mount) => {
      const document = sampleDocument('owner');
      if (scenario === 'anonymous author') document.author.accountId = '';
      if (scenario === 'existing document avatar') document.author.avatarUrl = 'https://example.test/author.jpg';
      const host: DocumentReaderHost = {
        viewer: { accountId: scenario === 'another author' ? 'acct_other' : 'acct_example_alex', displayName: 'Alex Morgan', avatarUrl: uploaded },
        sessionId: null, agentName: null, people: [],
      };
      const { api } = createMemoryDocumentApi(document);
      const root = await mount(createElement(DocumentReaderHostContext.Provider, { value: host },
        createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));
      const chip = root.querySelector<HTMLButtonElement>('.app-document-mention');
      assert.ok(chip);
      await act(async () => { chip.click(); });
      const images = Array.from(root.querySelectorAll<HTMLImageElement>('.app-document-people img'));
      const urls = images.map((image) => image.src);
      if (scenario === 'own missing avatar') {
        assert.ok(urls.some((url) => url.endsWith(`/v1/avatars/assets/ava_${'a'.repeat(32)}/256.jpg`)), 'the card resolves the real uploaded profile image');
      } else if (scenario === 'existing document avatar') {
        assert.ok(urls.includes('https://example.test/author.jpg'));
      } else {
        assert.ok(urls.every((url) => !url.includes('/v1/avatars/assets/')), 'never substitute the viewer image for another or unidentified author');
      }
    });
  });
}
