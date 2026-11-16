// Typed calls for `/v1/cloud/common-ground/rooms/:code/gallery…`, folded into the Grounding client.
// Replies are normalised so missing fields read as their defaults; items without an id are dropped.

import type { CgGalleryCandidate, CgGalleryComment, CgGalleryItem, CgGalleryItemView, CgGalleryList, CgPerson, CgRelationship } from './types';

type Data = <T>(method: string, path: string, body?: unknown) => Promise<T>;
type Bytes = (path: string) => Promise<Blob>;
type Raw = Record<string, unknown>;

const enc = encodeURIComponent;
const record = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The person with a `relationship` sent beside it folded in, as the other Grounding replies do. */
function personOf(value: unknown, beside?: unknown): CgPerson {
  const raw = record(value);
  const relationship = (beside ?? raw.relationship) as CgRelationship | undefined;
  return {
    ...(raw as Partial<CgPerson>),
    accountId: text(raw.accountId),
    name: text(raw.name),
    avatarUrl: textOrNull(raw.avatarUrl),
    ...(relationship && typeof relationship === 'object' ? { relationship } : {}),
  };
}

export function galleryItemOf(value: unknown): CgGalleryItem | null {
  const raw = record(value);
  const itemId = text(raw.itemId);
  if (!itemId) return null;
  const fileName = text(raw.fileName);
  return {
    itemId,
    attachmentId: text(raw.attachmentId),
    title: text(raw.title) || fileName,
    fileName,
    contentType: textOrNull(raw.contentType),
    sizeBytes: numOrNull(raw.sizeBytes),
    topic: textOrNull(raw.topic),
    preview: textOrNull(raw.preview),
    person: personOf(raw.person, raw.relationship),
    mine: raw.mine === true,
    commentCount: Math.max(0, numOrNull(raw.commentCount) ?? 0),
    createdAt: text(raw.createdAt),
  };
}

export function galleryCommentOf(value: unknown): CgGalleryComment | null {
  const raw = record(value);
  const commentId = text(raw.commentId);
  if (!commentId) return null;
  return { commentId, person: personOf(raw.person), body: text(raw.body), mine: raw.mine === true, createdAt: text(raw.createdAt) };
}

function candidateOf(value: unknown): CgGalleryCandidate | null {
  const raw = record(value);
  const attachmentId = text(raw.attachmentId);
  if (!attachmentId) return null;
  const fileName = text(raw.fileName);
  return {
    attachmentId,
    title: text(raw.title) || fileName,
    fileName,
    contentType: textOrNull(raw.contentType),
    sizeBytes: numOrNull(raw.sizeBytes),
    updatedAt: text(raw.updatedAt),
    shared: raw.shared === true,
  };
}

const items = (value: unknown) => list(value).map(galleryItemOf).filter((item): item is CgGalleryItem => item !== null);

function galleryListOf(value: unknown): CgGalleryList {
  const raw = record(value);
  return { items: items(raw.items), canShare: raw.canShare === true };
}

function itemViewOf(value: unknown): CgGalleryItemView {
  const raw = record(value);
  const item = galleryItemOf(raw.item);
  if (!item) throw new Error('Something went wrong. Try again.');
  return { item, comments: list(raw.comments).map(galleryCommentOf).filter((comment): comment is CgGalleryComment => comment !== null) };
}

export function galleryRoutes(data: Data, bytes: Bytes) {
  const g = (code: string, path = '') => `common-ground/rooms/${enc(code)}/gallery${path}`;
  const one = (code: string, itemId: string, path = '') => g(code, `/${enc(itemId)}${path}`);
  return {
    /** The room's Gallery, newest first, and whether the viewer may share to it. */
    gallery: async (code: string) => galleryListOf(await data<unknown>('GET', g(code))),
    /** My own artifacts I may share here; `shared` marks those already in the Gallery. */
    galleryCandidates: async (code: string) => list(record(await data<unknown>('GET', g(code, '/candidates'))).artifacts)
      .map(candidateOf).filter((candidate): candidate is CgGalleryCandidate => candidate !== null),
    /** Shares one to eight of my artifacts, with a room topic or none; the reply is the new items. */
    shareToGallery: async (code: string, attachmentIds: string[], topic: string | null) => (
      items(record(await data<unknown>('POST', g(code), { attachmentIds, topic })).items)
    ),
    removeFromGallery: (code: string, itemId: string) => data<null>('DELETE', one(code, itemId)),
    galleryItem: async (code: string, itemId: string) => itemViewOf(await data<unknown>('GET', one(code, itemId))),
    /** The shared file's bytes, with its content type. */
    galleryContent: (code: string, itemId: string) => bytes(one(code, itemId, '/content')),
    addGalleryComment: async (code: string, itemId: string, body: string) => {
      const comment = galleryCommentOf(record(await data<unknown>('POST', one(code, itemId, '/comments'), { body })).comment);
      if (!comment) throw new Error('Something went wrong. Try again.');
      return comment;
    },
    deleteGalleryComment: (code: string, itemId: string, commentId: string) => data<null>('DELETE', one(code, itemId, `/comments/${enc(commentId)}`)),
  };
}
