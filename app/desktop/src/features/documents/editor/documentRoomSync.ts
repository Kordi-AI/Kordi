import type { Editor, JSONContent } from '@tiptap/core';
import type { MarkdownManager } from '@tiptap/markdown';
import type { Schema } from '@tiptap/pm/model';
import { prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';

import type { DocumentResponse } from '../documentShareTypes';
import { parseBlocks, serializeBlocks, sourceOfBlocks, type SourceBlock } from './documentBlockIds';
import { mergeBlocks } from './documentBlockMerge';
import { selectionBlockId } from './documentEditorCommands';
import { placeAnchor, reconciledContent, selectionAnchor, type SelectionAnchor } from './documentEditorSync';
import { DocumentRoom, knownDocument, ROOM_FIELD, type DocumentRoomOptions } from './documentRoom';

/** How long an unused init grant lasts on the server; an empty room asks again after it. */
const INIT_RETRY_MS = 30_000;
/** Wait for the editor that provides the seed (it loads lazily). */
const SEED_EDITOR_RETRY_MS = 200;
/** A stale room binds only after the latest document came in; a failed fetch is tried again after this. */
const STALE_FETCH_RETRY_MS = 2_000;
/** How long the bound editor waits for the room content that holds the caret's block. */
const FOCUS_WAIT_MS = 2_000;

/** Converting between the room and Markdown. Any editor of the document has it, and it outlives the editor. */
type RoomCodec = { schema: Schema; manager: MarkdownManager };

const codecOf = (editor: Editor): RoomCodec => ({ schema: editor.schema, manager: editor.markdown! });

const sameBlocks = (left: readonly SourceBlock[], right: readonly SourceBlock[]) => left.length === right.length
  && left.every((block, index) => block.id === right[index].id && block.source === right[index].source);

/** The room's top-level nodes, through the schema so they carry the same attributes as an editor's own JSON. */
function roomNodes(codec: RoomCodec, room: DocumentRoom): JSONContent[] {
  return (codec.schema.nodeFromJSON(yDocToProsemirrorJSON(room.ydoc, ROOM_FIELD)).toJSON() as JSONContent).content ?? [];
}

/** The room's content as editor blocks (Markdown with id comments). */
function roomBlocks(codec: RoomCodec, room: DocumentRoom) {
  return serializeBlocks(codec.manager, { type: 'doc', content: roomNodes(codec, room) });
}

/** Blocks as the server lists them, as editor blocks that compare with the room's. */
function storeBlocks(codec: RoomCodec, blocks: readonly SourceBlock[], legacyIds: Record<string, string>) {
  if (blocks.length === 0) return [];
  return serializeBlocks(codec.manager, codec.schema.nodeFromJSON(parseBlocks(codec.manager, blocks, legacyIds).doc).toJSON() as JSONContent);
}

/**
 * Writes `blocks` into the room when they differ from its content; true when it wrote. Nodes of unchanged blocks
 * stay as they are, and empty paragraphs (no Markdown of their own, such as one just started) stay after the
 * block they followed.
 */
function writeRoom(codec: RoomCodec, room: DocumentRoom, blocks: readonly SourceBlock[]) {
  const current: SourceBlock[] = [];
  const kept = new Map<string, JSONContent>();
  const emptyAfter = new Map<string | null, JSONContent[]>();
  let previous: string | null = null;
  for (const node of roomNodes(codec, room)) {
    const [block] = serializeBlocks(codec.manager, { type: 'doc', content: [node] });
    if (!block) {
      emptyAfter.set(previous, [...(emptyAfter.get(previous) ?? []), node]);
      continue;
    }
    current.push(block);
    kept.set(`${block.id}\n${block.source}`, node);
    previous = block.id;
  }
  if (sameBlocks(blocks, current)) return false;
  const content = [...(emptyAfter.get(null) ?? [])];
  for (const block of blocks) {
    const node = kept.get(`${block.id}\n${block.source}`);
    content.push(...(node ? [node] : parseBlocks(codec.manager, [block]).doc.content ?? []), ...(emptyAfter.get(block.id) ?? []));
  }
  const doc = content.length > 0 ? { type: 'doc', content } : parseBlocks(codec.manager, []).doc;
  prosemirrorJSONToYXmlFragment(codec.schema, doc, room.fragment);
  return true;
}

/** Focuses the bound editor with the caret at `anchor`, once the room content holding its block has rendered. */
function focusAt(editor: Editor, anchor: SelectionAnchor) {
  let done = false;
  const stop = () => {
    done = true;
    editor.off('update', later);
  };
  const place = () => {
    if (done || editor.isDestroyed || !placeAnchor(editor, anchor)) return;
    stop();
    editor.view.focus();
  };
  // The room's content renders into the new editor after it mounts; place the caret after that transaction.
  const later = () => { setTimeout(place, 0); };
  editor.on('update', later);
  place();
  setTimeout(stop, FOCUS_WAIT_MS);
}

export type DocumentRoomSyncOptions = Omit<DocumentRoomOptions, 'markdown' | 'unchanged' | 'onConflict' | 'onStale'> & {
  /** `k:` ids the editors chose for index ids, for reading the server's blocks. */
  legacyIds: Record<string, string>;
  /** Both sides changed a block ("Updated elsewhere"). */
  onUpdatedElsewhere: () => void;
};

/**
 * One editor's collaboration room plus what keeps it in agreement with the
 * Markdown store: the unbound editor's edits merged in at binding, the
 * revision the store last agreed with (`room.known`), and saves made outside
 * the room merged in three ways by block, by the snapshot writer or by
 * whoever a ticket's stale hint reaches.
 */
export class DocumentRoomSync {
  readonly room: DocumentRoom;
  private codec: RoomCodec | null = null;
  /** The bound editor while it is mounted. */
  private editor: Editor | null = null;
  /** The unbound editor's caret when it had focus, for the bound editor to take over. */
  private handoff: SelectionAnchor | null = null;
  private staleBusy = false;
  private readonly options: DocumentRoomSyncOptions;

  constructor(options: DocumentRoomSyncOptions) {
    this.options = options;
    this.room = new DocumentRoom({
      ...options,
      markdown: () => this.markdown(),
      unchanged: (markdown) => this.matchesKnown(markdown),
      onConflict: (document) => this.reconcile(document),
      onStale: () => { void this.afterStaleSync(); },
    });
  }

  /** The room as Markdown for snapshots, once an editor is bound. */
  private markdown() {
    return this.room.bound && this.codec ? sourceOfBlocks(roomBlocks(this.codec, this.room)) : null;
  }

  /** Whether `markdown` is what the store holds at `known` (written the way the room writes it). */
  private matchesKnown(markdown: string) {
    const { known } = this.room;
    return Boolean(known && this.codec) && markdown === sourceOfBlocks(this.storeBlocks(known!.blocks));
  }

  private updatedElsewhere() {
    if (!this.room.detached) this.options.onUpdatedElsewhere();
  }

  private storeBlocks(blocks: readonly SourceBlock[]) {
    return storeBlocks(this.codec!, blocks, this.options.legacyIds);
  }

  /**
   * Binds the room. The unbound editor's unsaved edits go in first, three-way by block against what it last loaded
   * from outside (`base`); its caret is kept when it had focus; `known` starts from `held`.
   */
  bind(unbound: Editor | null, base: readonly SourceBlock[], held: DocumentResponse | null) {
    let wrote = false;
    if (unbound && !unbound.isDestroyed) {
      const codec = (this.codec ??= codecOf(unbound));
      const merged = mergeBlocks(base, serializeBlocks(codec.manager, unbound.getJSON()), roomBlocks(codec, this.room), selectionBlockId(unbound));
      wrote = writeRoom(codec, this.room, merged.blocks);
      if (merged.conflict) this.updatedElsewhere();
      this.handoff = unbound.isFocused ? selectionAnchor(unbound) : null;
      // Its edits are in the room now; nothing typed before the bound editor replaces it may land here.
      unbound.setEditable(false, false);
    }
    if (held) this.room.known = knownDocument(held);
    const differs = Boolean(this.room.known && this.codec) && !this.matchesKnown(sourceOfBlocks(roomBlocks(this.codec!, this.room)));
    this.room.markBound(wrote || differs);
  }

  /** The bound editor mounted (null: it left); it takes over the unbound editor's caret. */
  attachEditor(editor: Editor | null) {
    this.editor = editor;
    if (!editor) return;
    this.codec ??= codecOf(editor);
    const anchor = this.handoff;
    this.handoff = null;
    if (anchor) focusAt(editor, anchor);
  }

  /**
   * First binding to a room a ticket called stale: `latest` comes in. Three-way against the held document when the
   * room is known to contain it (a room snapshot older than `latest`); otherwise the latest version of every block
   * that differs wins, and blocks only the room has stay.
   */
  reconcileAtBind(editor: Editor, latest: DocumentResponse, held: DocumentResponse | null) {
    const codec = (this.codec ??= codecOf(editor));
    const revision = (document: DocumentResponse) => document.revision ?? 0;
    if (held && revision(held) > (held.outsideRoomRevision ?? 0) && revision(held) < revision(latest)) {
      const merged = mergeBlocks(this.storeBlocks(held.blocks), roomBlocks(codec, this.room), this.storeBlocks(latest.blocks), null);
      writeRoom(codec, this.room, merged.blocks);
      if (merged.conflict) this.updatedElsewhere();
    } else {
      const target = reconciledContent(editor, yDocToProsemirrorJSON(this.room.ydoc, ROOM_FIELD), latest.blocks);
      writeRoom(codec, this.room, serializeBlocks(codec.manager, codec.schema.nodeFromJSON(target).toJSON() as JSONContent));
    }
    this.room.staleRevision = false;
  }

  private canReconcile() {
    return Boolean(this.codec && this.room.known) && !this.room.isDestroyed && this.room.status === 'connected' && this.room.isSnapshotWriter();
  }

  /** Merges `remote` (newer than `known`) into the room, three-way by block with the room as the local side. */
  private merge(remote: DocumentResponse) {
    const { known } = this.room;
    if (!this.codec || !known || this.room.isDestroyed || (remote.revision ?? 0) <= known.revision) return;
    const merged = mergeBlocks(this.storeBlocks(known.blocks), roomBlocks(this.codec, this.room), this.storeBlocks(remote.blocks), this.editor && !this.editor.isDestroyed ? selectionBlockId(this.editor) : null);
    writeRoom(this.codec, this.room, merged.blocks);
    this.room.known = knownDocument(remote);
    if (merged.conflict) this.updatedElsewhere();
  }

  /** Snapshot writer only: merges a save made outside the room into it, then snapshots on that save's revision. */
  async reconcile(remote: DocumentResponse) {
    if (!this.canReconcile()) return;
    this.merge(remote);
    await this.room.writeSnapshot();
  }

  /**
   * A newer document from the store while bound (a refetch after `document.updated`, a save's answer). A room
   * snapshot (revision past `outsideRoomRevision`) is already in the room; a save from outside is not yet, and only
   * the snapshot writer merges it in.
   */
  learn(remote: DocumentResponse) {
    const { known } = this.room;
    const revision = remote.revision ?? 0;
    if (!this.room.bound || !known || this.room.detached || revision <= known.revision) return;
    if (revision > (remote.outsideRoomRevision ?? 0)) this.room.known = knownDocument(remote);
    else void this.reconcile(remote);
  }

  /** A reconnect's ticket said the room misses a save from outside: the writer reconciles, anyone else merges it in. */
  private async afterStaleSync() {
    if (this.staleBusy || !this.codec || !this.room.known) return;
    this.staleBusy = true;
    try {
      const latest = await this.options.api.getDocument(this.options.attachmentId).catch(() => null);
      if (!latest || this.room.isDestroyed) return;
      this.room.staleRevision = false;
      if (this.canReconcile()) await this.reconcile(latest);
      else this.merge(latest);
    } finally {
      this.staleBusy = false;
    }
  }
}

type PrepareSource = {
  /** The unbound editor (it loads lazily) and what it last loaded from outside. */
  editor: () => Editor | null;
  base: () => readonly SourceBlock[];
  /** The newest document from the store the view holds. */
  held: () => DocumentResponse | null;
  latest: () => Promise<DocumentResponse | null>;
};

/**
 * Seeds an empty room (the one editor the server grants it to writes its
 * current content in one transaction), waits for someone else's seed, or,
 * when a ticket says a save outside the room is missing from it, brings that
 * save in. Then binds, which merges the unbound editor's edits into the room
 * on every path. Calls `onReady` once the room has content to bind to.
 */
export function prepareRoom(sync: DocumentRoomSync, source: PrepareSource, onReady: () => void) {
  const { room } = sync;
  const fragment = room.fragment;
  let cancelled = false;
  let done = false;
  let waitingForSeed = false;
  let fetched: DocumentResponse | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    if (done) return true;
    if (cancelled || fragment.length === 0) return false;
    done = true;
    fragment.unobserve(observer);
    sync.bind(source.editor(), source.base(), fetched ?? source.held());
    onReady();
    return true;
  };
  const observer = () => { if (waitingForSeed) finish(); };
  const retry = (ms: number) => { timer = setTimeout(() => { void attempt(); }, ms); };
  const attempt = async () => {
    timer = null;
    if (cancelled || done) return;
    const editor = source.editor();
    if (fragment.length > 0) {
      if (room.staleRevision) {
        if (!editor) {
          retry(SEED_EDITOR_RETRY_MS);
          return;
        }
        const latest = await source.latest();
        if (cancelled) return;
        if (!latest) {
          retry(STALE_FETCH_RETRY_MS);
          return;
        }
        if (!editor.isDestroyed) sync.reconcileAtBind(editor, latest, source.held());
        fetched = latest;
      }
      finish();
      return;
    }
    if (!editor) {
      retry(SEED_EDITOR_RETRY_MS);
      return;
    }
    waitingForSeed = true;
    const granted = await room.requestInit();
    if (cancelled || done) return;
    if (granted && fragment.length === 0 && !editor.isDestroyed) {
      prosemirrorJSONToYXmlFragment(editor.schema, editor.getJSON(), fragment);
    }
    // Without the grant, someone else is seeding; the observer binds once their content arrives.
    if (!finish()) retry(INIT_RETRY_MS);
  };
  fragment.observe(observer);
  void attempt();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    if (!done) fragment.unobserve(observer);
  };
}
