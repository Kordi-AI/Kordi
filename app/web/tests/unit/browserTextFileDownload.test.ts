import assert from 'node:assert/strict';
import test from 'node:test';
import { runBrowserAttachmentCommand } from '@web/runtime/browserAttachments';

test('saving a text file downloads a JSON Lines blob under the requested name', async () => {
  const clicked: Array<{ href: string; download: string; type: string }> = [];
  const revoked: string[] = [];
  const blobs = new Map<string, Blob>();
  const originalDocument = (globalThis as { document?: unknown }).document;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalSetTimeout = globalThis.setTimeout;
  const pending: Array<() => void> = [];
  const anchor = { href: '', download: '', click: () => {}, remove: () => {} };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => anchor, body: { appendChild: () => {} } },
  });
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:synthetic/${blobs.size + 1}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  globalThis.setTimeout = ((callback: () => void) => { pending.push(callback); return 0; }) as unknown as typeof setTimeout;
  try {
    anchor.click = () => {
      const blob = blobs.get(anchor.href)!;
      clicked.push({ href: anchor.href, download: anchor.download, type: blob.type });
    };
    const result = await runBrowserAttachmentCommand('desktop_save_text_file_as', {
      name: 'kordi-trace-launch/plan-20261114-0930.jsonl',
      contents: '{"type":"session"}\n',
    });
    assert.equal(result, 'kordi-trace-launch_plan-20261114-0930.jsonl');
    assert.equal(clicked.length, 1);
    assert.equal(clicked[0].download, 'kordi-trace-launch_plan-20261114-0930.jsonl');
    assert.equal(clicked[0].type, 'application/x-ndjson');
    assert.equal(await blobs.get(clicked[0].href)!.text(), '{"type":"session"}\n');
    assert.deepEqual(revoked, []);
    pending.forEach((callback) => callback());
    assert.deepEqual(revoked, [clicked[0].href]);
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    globalThis.setTimeout = originalSetTimeout;
  }
});
