// A room's Gallery: the artifacts room members shared, my own artifacts I may share, the open item
// with its comments, and the room page's tab. Comments land at once and roll back if the server
// refuses; shares and removals wait for the server. An older server without the routes turns the
// Gallery off (`support.gallery`), and the room page stays as it was.

import { CommonGroundError, commonGroundErrorCode, commonGroundErrorMessage, isRouteMissing, type CommonGroundClient } from './client';
import type { CgScreen, CgState } from './store';
import type { CgGalleryComment, CgGalleryItem, CgGalleryItemView, CgGalleryScreen, CgGalleryState, CgPerson, CgRoomTab } from './types';

/** The parts of the store these operations use. */
export type CgGalleryHost = {
  readonly client: CommonGroundClient;
  getSnapshot: () => CgState;
  set: (patch: Partial<CgState>) => void;
  top: () => CgScreen;
  back: () => void;
};

/** Up to this many artifacts go into one share. */
export const GALLERY_SHARE_MAX = 8;
export const GALLERY_COMMENT_MAX = 2000;

export const galleryItemKey = (code: string, itemId: string) => `${code}:${itemId}`;
export const galleryCandidatesKey = (code: string) => `gallery-candidates:${code}`;
export const galleryShareKey = (code: string) => `gallery-share:${code}`;
export const galleryRemoveKey = (itemId: string) => `gallery-remove:${itemId}`;
export const galleryCommentKey = (itemId: string) => `gallery-comment:${itemId}`;

const GALLERY_ERRORS: Record<string, string> = {
  common_ground_gallery_limit: 'You can share up to 20 items in a room.',
  common_ground_gallery_not_shareable: 'Some of these can’t be shared.',
};

function galleryErrorMessage(error: unknown): string {
  const code = commonGroundErrorCode(error);
  return (code && GALLERY_ERRORS[code]) || commonGroundErrorMessage(error);
}

function patchGallery(host: CgGalleryHost, patch: (gallery: CgGalleryState) => Partial<CgGalleryState>) {
  const gallery = host.getSnapshot().gallery;
  host.set({ gallery: { ...gallery, ...patch(gallery) } });
}

/** Turns the Gallery off for a server without its routes; true when it did. */
function unsupported(host: CgGalleryHost, error: unknown): boolean {
  if (!isRouteMissing(error)) return false;
  host.set({ support: { ...host.getSnapshot().support, gallery: false } });
  return true;
}

async function busyWith<T>(host: CgGalleryHost, key: string, work: () => Promise<T>): Promise<T> {
  host.set({ busy: key, notice: null });
  try {
    return await work();
  } finally {
    if (host.getSnapshot().busy === key) host.set({ busy: null });
  }
}

/** The room page's segment, kept so going back from an item shows the Gallery again. */
export function setRoomTab(host: Pick<CgGalleryHost, 'getSnapshot' | 'set'>, code: string, tab: CgRoomTab) {
  const gallery = host.getSnapshot().gallery;
  if (gallery.tabs[code] !== tab) host.set({ gallery: { ...gallery, tabs: { ...gallery.tabs, [code]: tab } } });
}

/** The item as the open screen or the room's list last had it. */
export function galleryItemFor(state: CgState, code: string, itemId: string): CgGalleryItem | null {
  return state.gallery.items[galleryItemKey(code, itemId)]?.item ?? state.gallery.lists[code]?.items.find((item) => item.itemId === itemId) ?? null;
}

/**
 * Loads a room's Gallery. `quiet` leaves failures off the page (the room opening, a hint). `retry`
 * (the room opening) asks even after a server lacked the routes, and turns the Gallery back on when
 * it answers, so a server swap needs no reload.
 */
export async function loadGallery(host: CgGalleryHost, code: string, { quiet = false, retry = false } = {}): Promise<void> {
  if (!host.getSnapshot().support.gallery && !retry) return;
  try {
    const list = await host.client.gallery(code);
    patchGallery(host, (gallery) => ({ lists: { ...gallery.lists, [code]: list } }));
    const support = host.getSnapshot().support;
    if (!support.gallery) host.set({ support: { ...support, gallery: true } });
  } catch (error) {
    if (!unsupported(host, error) && !quiet) host.set({ notice: commonGroundErrorMessage(error) });
  }
}

/** Loads my artifacts for the Share dialog; the old list is dropped first so the dialog shows the server's. */
export async function loadCandidates(host: CgGalleryHost, code: string): Promise<void> {
  patchGallery(host, (gallery) => {
    const { [code]: _stale, ...candidates } = gallery.candidates;
    return { candidates };
  });
  await busyWith(host, galleryCandidatesKey(code), async () => {
    try {
      const candidates = await host.client.galleryCandidates(code);
      patchGallery(host, (gallery) => ({ candidates: { ...gallery.candidates, [code]: candidates } }));
    } catch (error) {
      host.set({ notice: galleryErrorMessage(error) });
    }
  });
}

/** Shares my picks with a topic or none; the new items go first. False when the server refused. */
export async function shareToGallery(host: CgGalleryHost, code: string, attachmentIds: string[], topic: string | null): Promise<boolean> {
  const ids = attachmentIds.slice(0, GALLERY_SHARE_MAX);
  if (!ids.length) return false;
  return busyWith(host, galleryShareKey(code), async () => {
    try {
      const added = await host.client.shareToGallery(code, ids, topic);
      const fresh = new Set(added.map((item) => item.itemId));
      const sharedIds = new Set([...ids, ...added.map((item) => item.attachmentId)]);
      patchGallery(host, (gallery) => {
        const list = gallery.lists[code] ?? { items: [], canShare: true };
        const candidates = gallery.candidates[code];
        return {
          lists: { ...gallery.lists, [code]: { ...list, items: [...added, ...list.items.filter((item) => !fresh.has(item.itemId))] } },
          ...(candidates ? { candidates: { ...gallery.candidates, [code]: candidates.map((entry) => (sharedIds.has(entry.attachmentId) ? { ...entry, shared: true } : entry)) } } : {}),
        };
      });
      return true;
    } catch (error) {
      host.set({ notice: galleryErrorMessage(error) });
      return false;
    }
  });
}

function dropItem(host: CgGalleryHost, code: string, itemId: string) {
  patchGallery(host, (gallery) => {
    const list = gallery.lists[code];
    const { [galleryItemKey(code, itemId)]: _gone, ...open } = gallery.items;
    return { items: open, ...(list ? { lists: { ...gallery.lists, [code]: { ...list, items: list.items.filter((item) => item.itemId !== itemId) } } } : {}) };
  });
}

const isItemScreen = (screen: CgScreen, code: string, itemId: string) => screen.name === 'galleryItem' && screen.code === code && screen.itemId === itemId;

/** The sharer takes an item out of the Gallery; an open item screen goes back to the room. */
export async function removeFromGallery(host: CgGalleryHost, code: string, itemId: string): Promise<boolean> {
  return busyWith(host, galleryRemoveKey(itemId), async () => {
    try {
      await host.client.removeFromGallery(code, itemId);
    } catch (error) {
      host.set({ notice: galleryErrorMessage(error) });
      return false;
    }
    dropItem(host, code, itemId);
    if (isItemScreen(host.top(), code, itemId)) host.back();
    return true;
  });
}

/** Keeps the room's list in step with an item the server just sent (comment count, topic). */
function landItem(host: CgGalleryHost, code: string, view: CgGalleryItemView) {
  patchGallery(host, (gallery) => {
    const list = gallery.lists[code];
    return {
      items: { ...gallery.items, [galleryItemKey(code, view.item.itemId)]: view },
      ...(list ? { lists: { ...gallery.lists, [code]: { ...list, items: list.items.map((item) => (item.itemId === view.item.itemId ? view.item : item)) } } } : {}),
    };
  });
}

/**
 * Fetches the open item and its comments (`refreshScreen`). An item that is gone (removed, or the
 * viewer left the room) or a server without the route goes back to the room.
 */
export async function refreshGalleryItem(host: CgGalleryHost, screen: CgGalleryScreen, { quiet = false } = {}): Promise<boolean> {
  const { code, itemId } = screen;
  try {
    landItem(host, code, await host.client.galleryItem(code, itemId));
  } catch (error) {
    const gone = error instanceof CommonGroundError && [403, 404].includes(error.status);
    if (unsupported(host, error) || gone) {
      dropItem(host, code, itemId);
      if (host.top() === screen) host.back();
    } else if (!quiet) {
      host.set({ notice: commonGroundErrorMessage(error) });
    }
  }
  return true;
}

function updateItem(host: CgGalleryHost, code: string, itemId: string, change: (view: CgGalleryItemView) => CgGalleryItemView, count: number) {
  patchGallery(host, (gallery) => {
    const key = galleryItemKey(code, itemId);
    const view = gallery.items[key];
    const list = gallery.lists[code];
    const recount = (item: CgGalleryItem) => ({ ...item, commentCount: Math.max(0, item.commentCount + count) });
    return {
      ...(view ? { items: { ...gallery.items, [key]: change({ ...view, item: recount(view.item) }) } } : {}),
      ...(list ? { lists: { ...gallery.lists, [code]: { ...list, items: list.items.map((item) => (item.itemId === itemId ? recount(item) : item)) } } } : {}),
    };
  });
}

let pendingSeq = 0;

/** A comment still on its way to the server; it cannot be deleted yet. */
export const isPendingComment = (comment: CgGalleryComment) => comment.commentId.startsWith('pending:');

/** Adds a comment at once and swaps in the server's copy; a refused comment is taken back. */
export async function addGalleryComment(host: CgGalleryHost, code: string, itemId: string, body: string, self: CgPerson): Promise<boolean> {
  const text = body.trim();
  if (!text || text.length > GALLERY_COMMENT_MAX) return false;
  const pendingId = `pending:${(pendingSeq += 1)}`;
  const pending: CgGalleryComment = { commentId: pendingId, person: self, body: text, mine: true, createdAt: new Date().toISOString() };
  updateItem(host, code, itemId, (view) => ({ ...view, comments: [...view.comments, pending] }), 1);
  // A refresh may land while the request is out, with or without the comment and without the pending copy.
  const has = (id: string) => host.getSnapshot().gallery.items[galleryItemKey(code, itemId)]?.comments.some((entry) => entry.commentId === id);
  const open = () => Boolean(host.getSnapshot().gallery.items[galleryItemKey(code, itemId)]);
  return busyWith(host, galleryCommentKey(itemId), async () => {
    try {
      const comment = await host.client.addGalleryComment(code, itemId, text);
      const [pendingShown, serverShown] = [has(pendingId), has(comment.commentId)];
      const count = !open() ? 0 : serverShown ? (pendingShown ? -1 : 0) : (pendingShown ? 0 : 1);
      updateItem(host, code, itemId, (view) => {
        if (serverShown) return { ...view, comments: view.comments.filter((entry) => entry.commentId !== pendingId) };
        const at = view.comments.findIndex((entry) => entry.commentId === pendingId);
        if (at < 0) return { ...view, comments: [...view.comments, comment] };
        return { ...view, comments: view.comments.map((entry, index) => (index === at ? comment : entry)) };
      }, count);
      return true;
    } catch (error) {
      const count = !open() || has(pendingId) ? -1 : 0;
      updateItem(host, code, itemId, (view) => ({ ...view, comments: view.comments.filter((entry) => entry.commentId !== pendingId) }), count);
      host.set({ notice: galleryErrorMessage(error) });
      return false;
    }
  });
}

/** Deletes a comment (its author, or the item's sharer) at once; it comes back if the server refuses. */
export async function deleteGalleryComment(host: CgGalleryHost, code: string, itemId: string, commentId: string): Promise<boolean> {
  const view = host.getSnapshot().gallery.items[galleryItemKey(code, itemId)];
  const index = view?.comments.findIndex((entry) => entry.commentId === commentId) ?? -1;
  if (!view || index < 0) return false;
  const removed = view.comments[index];
  updateItem(host, code, itemId, (current) => ({ ...current, comments: current.comments.filter((entry) => entry.commentId !== commentId) }), -1);
  return busyWith(host, galleryCommentKey(itemId), async () => {
    try {
      await host.client.deleteGalleryComment(code, itemId, commentId);
      return true;
    } catch (error) {
      updateItem(host, code, itemId, (current) => {
        if (current.comments.some((entry) => entry.commentId === commentId)) return current;
        const comments = [...current.comments];
        comments.splice(Math.min(index, comments.length), 0, removed);
        return { ...current, comments };
      }, 1);
      host.set({ notice: galleryErrorMessage(error) });
      return false;
    }
  });
}

/**
 * `common_ground.gallery.updated` (a share, removal, comment or comment deletion in a room): refetches
 * that room's Gallery when it is loaded, and the open item when it is the one named.
 */
export async function receiveGalleryHints(host: CgGalleryHost, hints: Array<{ code: string; itemId: string | null }>): Promise<void> {
  const state = host.getSnapshot();
  if (!state.support.gallery) return;
  const work: Promise<unknown>[] = [];
  for (const code of new Set(hints.map((hint) => hint.code))) {
    if (state.gallery.lists[code]) work.push(loadGallery(host, code, { quiet: true }));
  }
  const top = host.top();
  if (top.name === 'galleryItem' && hints.some((hint) => hint.code === top.code && hint.itemId === top.itemId)) {
    work.push(refreshGalleryItem(host, top, { quiet: true }));
  }
  await Promise.all(work);
}
