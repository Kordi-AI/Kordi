// Fictional Gallery for the login-free Grounding preview: the Poster session room's shared artifacts,
// my own artifacts for Share, comments, file contents, and a stub for the `rooms/:code/gallery` routes.

import type { CgGalleryCandidate, CgGalleryComment, CgGalleryItem, CgPerson } from '../../src/features/commonGround/types';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const NOTES = `# Memory benchmark notes

Agents forget what they learned between sessions. These notes compare three stores on the same tasks.

## What we measure

- Recall after 1, 7 and 30 sessions
- Tokens spent on retrieval per answer
- How often the agent cites the wrong session

## Stores

| Store | Recall at 30 | Tokens |
| --- | --- | --- |
| Episodic | 71% | 1.9k |
| Semantic | 64% | 1.1k |
| Hybrid | 78% | 2.3k |

## Open questions

- Should summaries expire after a month?
- Do we score partial recall?`;

const RERANK = `import { score } from './bm25';

export type Hit = { id: string; text: string; score: number };

/** Reranks the first-stage hits with a cross-encoder and keeps the best k. */
export async function rerank(query: string, hits: Hit[], k = 10): Promise<Hit[]> {
  const scored = await Promise.all(hits.map(async (hit) => ({
    ...hit,
    score: 0.3 * hit.score + 0.7 * (await score(query, hit.text)),
  })));
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}`;

const RUNS = `Model,Tasks,Recall,Cost
Small,120,61%,$4
Medium,120,72%,$11
Large,120,79%,$26
Hybrid store,120,81%,$14`;

const POSTER = `<!doctype html><html><head><style>body{margin:0;font:15px -apple-system,sans-serif;background:linear-gradient(135deg,#f6d6bd,#f2a66d);color:#3a2a1c}
main{padding:40px}h1{font-size:30px;margin:0 0 8px}.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:24px}
.cols div{background:rgba(255,255,255,.7);border-radius:12px;padding:14px;min-height:90px}</style></head>
<body><main><h1>Memory that lasts</h1><p>Long-horizon agents, three stores, one benchmark.</p>
<div class="cols"><div><b>Episodic</b><p>Raw sessions, recalled by search.</p></div><div><b>Semantic</b><p>Facts distilled after each session.</p></div><div><b>Hybrid</b><p>Both, with a router.</p></div></div></main></body></html>`;

const WHITEBOARD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#f4f2ec"/>
<rect x="30" y="30" width="80" height="70" rx="4" fill="#fbe38e"/><rect x="130" y="50" width="80" height="70" rx="4" fill="#f6b8c8"/>
<rect x="240" y="30" width="80" height="70" rx="4" fill="#b9dbf7"/><rect x="80" y="160" width="80" height="70" rx="4" fill="#c5e8b7"/>
<rect x="210" y="170" width="80" height="70" rx="4" fill="#fbe38e"/><path d="M40 140 C140 120 260 150 360 130" stroke="#3a3f4b" stroke-width="4" fill="none" opacity=".55"/></svg>`;

/** A one-page PDF with a title line, so the PDF viewer has something real to show. */
function tinyPdf(title: string): string {
  const stream = `BT /F1 20 Tf 40 240 Td (${title}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 297] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const at = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

type Person = Omit<CgPerson, 'relationship'> & { relationship?: CgPerson['relationship'] };
type File = { title: string; fileName: string; contentType: string; text: string };

const FILES: Record<string, File> = {
  att_notes: { title: 'Memory benchmark notes', fileName: 'memory-benchmarks.md', contentType: 'text/markdown', text: NOTES },
  att_rerank: { title: 'Rerank harness', fileName: 'rerank.ts', contentType: 'text/plain', text: RERANK },
  att_runs: { title: 'Eval runs by model', fileName: 'eval-runs.csv', contentType: 'text/csv', text: RUNS },
  att_poster: { title: 'Poster draft', fileName: 'poster.html', contentType: 'text/html', text: POSTER },
  att_board: { title: 'Whiteboard photo', fileName: 'whiteboard.svg', contentType: 'image/svg+xml', text: WHITEBOARD },
  att_protocol: { title: 'Study protocol', fileName: 'study-protocol.pdf', contentType: 'application/pdf', text: tinyPdf('Study protocol') },
  att_plan: { title: 'Eval plan', fileName: 'eval-plan.md', contentType: 'text/markdown', text: '# Eval plan\n\nThree stores, 120 tasks, recall at 1, 7 and 30 sessions.' },
  att_reading: { title: 'Reading notes', fileName: 'reading-notes.md', contentType: 'text/markdown', text: '# Reading notes\n\nSurvey section 4 compares episodic and semantic stores.' },
  att_recall: { title: 'Recall at k', fileName: 'recall-at-k.csv', contentType: 'text/csv', text: 'k,Recall\n1,41%\n5,66%\n10,74%' },
  att_types: { title: 'Memory store types', fileName: 'stores.ts', contentType: 'text/plain', text: 'export type Store = "episodic" | "semantic" | "hybrid";' },
  att_agenda: { title: 'Workshop agenda', fileName: 'workshop-agenda.pdf', contentType: 'application/pdf', text: tinyPdf('Workshop agenda') },
};

/** The Poster session room's Gallery, my own artifacts, and comments; `people` are the room's members and me. */
export function commonGroundGalleryFixtures(people: { self: Person; maya: Person; hana: Person; ines: Person; rafa: Person }) {
  const { self, maya, hana, ines, rafa } = people;
  let next = 0;
  const shareItem = (attachmentId: string, person: Person, topic: string | null, minutes: number): CgGalleryItem => {
    const file = FILES[attachmentId];
    next += 1;
    return {
      itemId: `gi_${next}`, attachmentId, title: file.title, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.text.length, topic,
      preview: file.contentType.startsWith('text/') ? file.text.slice(0, 800) : null,
      person: person as CgPerson, mine: person.accountId === self.accountId, commentCount: 0, createdAt: ago(minutes),
    };
  };
  const items: CgGalleryItem[] = [
    shareItem('att_notes', hana, 'Agent memory', 25),
    shareItem('att_rerank', rafa, 'Retrieval', 50),
    shareItem('att_runs', maya, 'Eval design', 80),
    shareItem('att_plan', self, 'Retrieval', 120),
    shareItem('att_poster', hana, 'Agent memory', 160),
    shareItem('att_board', ines, null, 200),
    shareItem('att_protocol', maya, 'Eval design', 260),
  ];
  const comment = (itemId: string, person: Person, body: string, minutes: number): CgGalleryComment => (
    { commentId: `gc_${itemId}_${minutes}`, person: person as CgPerson, body, mine: person.accountId === self.accountId, createdAt: ago(minutes) }
  );
  const comments: Record<string, CgGalleryComment[]> = {
    gi_1: [
      comment('gi_1', maya, 'Does recall at 30 include summaries?', 20),
      comment('gi_1', rafa, 'The hybrid row matches what we see in retrieval.', 12),
      comment('gi_1', self, 'Happy to share our eval harness for this.', 4),
    ],
    gi_3: [comment('gi_3', hana, 'Medium looks like the sweet spot.', 40)],
  };
  for (const entry of items) entry.commentCount = comments[entry.itemId]?.length ?? 0;
  const mine = ['att_plan', 'att_reading', 'att_recall', 'att_types', 'att_agenda'];

  const candidates = (): CgGalleryCandidate[] => mine.map((attachmentId, index) => {
    const file = FILES[attachmentId];
    return {
      attachmentId, title: file.title, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.text.length,
      updatedAt: ago(60 * 24 * (index + 1)), shared: items.some((entry) => entry.attachmentId === attachmentId),
    };
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  /** Answers `rooms/4821/gallery…`; null for any other path. */
  function reply(method: string, path: string, body: Record<string, unknown>): Response | null {
    const match = /^rooms\/4821\/gallery(?:\/([^/]+))?(?:\/(content|comments))?(?:\/([^/]+))?$/.exec(path);
    if (!match) return null;
    const [, id, part, commentId] = match;
    if (!id) {
      if (method === 'POST') {
        const ids = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((entry): entry is string => typeof entry === 'string' && entry in FILES) : [];
        const added = ids.map((attachmentId) => shareItem(attachmentId, self, typeof body.topic === 'string' ? body.topic : null, 0));
        items.unshift(...added);
        return json({ items: added }, 201);
      }
      return json({ items, canShare: true });
    }
    if (id === 'candidates') return json({ artifacts: candidates() });
    const entry = items.find((candidate) => candidate.itemId === id);
    if (!entry) return json({ errorCode: 'common_ground_gallery_not_found', message: 'This item was removed.' }, 404);
    if (part === 'content') {
      const file = FILES[entry.attachmentId];
      return new Response(file.text, { status: 200, headers: { 'Content-Type': file.contentType } });
    }
    const list = (comments[id] ??= []);
    if (part === 'comments' && method === 'POST') {
      const added = comment(id, self, String(body.body ?? ''), 0);
      list.push(added);
      entry.commentCount = list.length;
      return json({ comment: added }, 201);
    }
    if (part === 'comments' && method === 'DELETE') {
      comments[id] = list.filter((existing) => existing.commentId !== commentId);
      entry.commentCount = comments[id].length;
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE') {
      items.splice(items.indexOf(entry), 1);
      return new Response(null, { status: 204 });
    }
    return json({ item: entry, comments: list });
  }

  return { items, comments, reply };
}
