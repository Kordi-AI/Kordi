import { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import type { SourceBlock } from '../documentBlockSource';
import type { DocumentShareApi } from '../documentShareApi';
import type { DocumentResponse } from '../documentShareTypes';
import type { DocumentPresencePeer } from '../documentPresence';

export type CollabUser = { name: string; color: string; accountId: string };
export type RoomPeer = DocumentPresencePeer;
export type RoomStatus = 'connecting' | 'connected' | 'offline';

/** The parts of `y-websocket`'s provider the room uses; tests pass an in-memory one. */
export type RoomProvider = {
  awareness: Awareness;
  params: Record<string, string>;
  shouldConnect: boolean;
  synced: boolean;
  connect(): void;
  disconnect(): void;
  destroy(): void;
  on(event: string, listener: (...args: never[]) => void): void;
  off(event: string, listener: (...args: never[]) => void): void;
};

export type ProviderFactory = (serverUrl: string, roomName: string, doc: Y.Doc, params: Record<string, string>) => RoomProvider;

/** `y-websocket` without its own reconnects: every connection needs a fresh single-use ticket. */
export const websocketProviderFactory: ProviderFactory = (serverUrl, roomName, doc, params) => new WebsocketProvider(serverUrl, roomName, doc, {
  connect: false,
  params,
  disableBc: true,
  shouldReconnect: () => false,
});

export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];
export const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** Waits before a failed snapshot is tried again; the last one repeats. */
export const SNAPSHOT_RETRY_MS = [2_000, 5_000, 10_000];
/** How long a room closed while offline with unsent edits keeps reconnecting in the background. */
export const CLOSE_LINGER_MS = 30_000;
/** After that background connection syncs, time for the socket to send the edits. */
export const CLOSE_DRAIN_MS = 300;
/** Refused snapshots in a row before the room stops reconciling until a snapshot lands again. */
const MAX_CONFLICTS = 3;
export const ROOM_FIELD = 'document';

/** What the Markdown store last agreed with the room: a revision and its blocks as the server lists them. */
export type KnownDocument = { revision: number; blocks: SourceBlock[] };

export function knownDocument(document: DocumentResponse): KnownDocument {
  return { revision: document.revision ?? 0, blocks: document.blocks.map(({ id, source }) => ({ id, source })) };
}

export type DocumentRoomOptions = {
  api: DocumentShareApi;
  attachmentId: string;
  user: CollabUser;
  createProvider?: ProviderFactory;
  /** Markdown (with block id comments) of the room's current content, for snapshots; null while there is none to save. */
  markdown: () => string | null;
  /** The store already holds exactly this Markdown at `known`; no snapshot is needed. */
  unchanged?: (markdown: string) => boolean;
  /** Index-to-id map a document's first stamped write carries. */
  blockIds?: () => Record<string, string> | null;
  onChange?: () => void;
  onSnapshot?: (document: DocumentResponse) => void;
  /** A snapshot was refused: a save from outside the room is newer than `known`. Merge it in, then snapshot again. */
  onConflict?: (document: DocumentResponse) => Promise<void> | void;
  /** A connection of the bound room synced after a ticket said a save outside the room is missing from it. */
  onStale?: () => void;
  /** Shorter waits in tests. */
  timing?: {
    reconnectDelaysMs?: readonly number[];
    snapshotDelayMs?: number;
    snapshotRetryMs?: readonly number[];
    closeLingerMs?: number;
    closeDrainMs?: number;
  };
};

const closingRooms = new Set<DocumentRoom>();

/** Rooms that were closed but are still delivering edits or a last snapshot (a page waits for them before it goes away). */
export function closingRoomCount() {
  return closingRooms.size;
}

/**
 * One collaboration room: a Y document, a socket per single-use ticket with a
 * reconnect loop (1, 2, 5, 10 s), the people present, and the Markdown
 * snapshots the connected editor with the smallest client id writes on the
 * revision the store last agreed with (`known`), retried with backoff.
 */
export class DocumentRoom {
  readonly ydoc = new Y.Doc();
  provider: RoomProvider | null = null;
  status: RoomStatus = 'connecting';
  /** True once a connection finished its first sync. */
  synced = false;
  /** A ticket said a save outside the room is missing from it; it stays set until someone merges that save in. */
  staleRevision = false;
  /** An editor edits the Y document; from binding until it unmounts, across reconnects. */
  bound = false;
  known: KnownDocument | null = null;
  /** The editor left; nothing calls back into it any more. */
  detached = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private dirtySinceSnapshot = false;
  /** Local edits made while the connection was down. */
  private offlineEdits = false;
  private snapshotFailures = 0;
  private conflicts = 0;
  private lingering = false;
  private settling = false;
  private destroyed = false;
  private readonly options: DocumentRoomOptions;

  constructor(options: DocumentRoomOptions) {
    this.options = options;
    this.ydoc.on('update', this.onUpdate);
  }

  get fragment() {
    return this.ydoc.getXmlFragment(ROOM_FIELD);
  }

  get isDestroyed() {
    return this.destroyed;
  }

  start() {
    void this.connect();
  }

  private notify() {
    if (!this.detached) this.options.onChange?.();
  }

  private async connect() {
    this.retryTimer = null;
    if (this.destroyed) return;
    let ticket;
    try {
      ticket = await this.options.api.requestCollabTicket(this.options.attachmentId);
    } catch {
      this.status = 'offline';
      this.notify();
      this.scheduleRetry();
      return;
    }
    if (this.destroyed) return;
    // The hint goes to one editor; keep it until it is acted on.
    if (ticket.staleRevision) this.staleRevision = true;
    const socketUrl = `${this.options.api.socketBaseUrl()}${ticket.url}`;
    const cut = socketUrl.lastIndexOf('/');
    if (!this.provider) {
      const create = this.options.createProvider ?? websocketProviderFactory;
      this.provider = create(socketUrl.slice(0, cut), socketUrl.slice(cut + 1), this.ydoc, { ticket: ticket.ticket });
      this.provider.awareness.setLocalStateField('user', this.options.user);
      this.provider.on('sync', this.onSync);
      this.provider.on('connection-close', this.onClose);
      this.provider.awareness.on('change', this.onAwareness);
    } else {
      this.provider.params = { ticket: ticket.ticket };
    }
    this.provider.connect();
  }

  private scheduleRetry() {
    if (this.destroyed || this.retryTimer) return;
    const delays = this.options.timing?.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => { void this.connect(); }, delay);
  }

  private readonly onSync = (isSynced: boolean) => {
    if (!isSynced || this.destroyed) return;
    this.synced = true;
    this.attempt = 0;
    this.status = 'connected';
    this.offlineEdits = false;
    this.conflicts = 0;
    this.notify();
    if (this.lingering) {
      if (this.settling) return;
      // Closed while offline: the edits are on their way; let the socket send them, then leave.
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.closeTimer = setTimeout(() => {
        this.closeTimer = setTimeout(() => this.teardown(), this.options.timing?.closeLingerMs ?? CLOSE_LINGER_MS);
        if (this.isSnapshotWriter()) void this.settle();
        else this.teardown();
      }, this.options.timing?.closeDrainMs ?? CLOSE_DRAIN_MS);
      return;
    }
    if (this.bound && this.staleRevision) this.options.onStale?.();
    // Changes made or received while away; a snapshot on an older base than an outside save is refused, not applied.
    if (this.dirtySinceSnapshot && this.isSnapshotWriter()) this.scheduleSnapshot();
  };

  private readonly onClose = () => {
    // The ticket was single-use: never let the provider reconnect with it.
    if (this.provider) this.provider.shouldConnect = false;
    const wasWriter = this.isSnapshotWriter();
    this.status = 'offline';
    this.notify();
    if (wasWriter && this.dirtySinceSnapshot && !this.lingering) void this.writeSnapshot();
    this.scheduleRetry();
  };

  private readonly onAwareness = () => this.notify();

  private readonly onUpdate = (_update: Uint8Array, origin: unknown) => {
    this.dirtySinceSnapshot = true;
    // A new change restarts the normal debounce, also after failed snapshots.
    this.snapshotFailures = 0;
    if (origin !== this.provider && this.status !== 'connected') this.offlineEdits = true;
    if (this.status !== 'connected' || this.lingering || !this.isSnapshotWriter()) return;
    this.scheduleSnapshot();
  };

  private scheduleSnapshot(delay = this.options.timing?.snapshotDelayMs ?? SNAPSHOT_DEBOUNCE_MS) {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      if (this.status === 'connected' && this.isSnapshotWriter()) void this.writeSnapshot();
    }, delay);
  }

  /** The editor with the smallest awareness client id writes snapshots; the others do not. */
  isSnapshotWriter() {
    const ids = [...(this.provider?.awareness.getStates().keys() ?? []), this.ydoc.clientID];
    return Math.min(...ids) === this.ydoc.clientID;
  }

  peers(): RoomPeer[] {
    const states = this.provider?.awareness.getStates() ?? new Map<number, Record<string, unknown>>();
    return [...states.entries()].flatMap(([clientId, state]) => {
      const user = (state as { user?: Partial<CollabUser> }).user;
      if (clientId === this.ydoc.clientID || !user?.name) return [];
      return [{ clientId, name: user.name, color: user.color ?? '#847ac4', accountId: user.accountId ?? null }];
    });
  }

  /** Asks to seed an empty room from Markdown; `true` for exactly one caller. */
  async requestInit() {
    try {
      return (await this.options.api.initCollab(this.options.attachmentId)).initialize;
    } catch {
      return false;
    }
  }

  /**
   * The editor is bound to the Y document. `dirty`: the room holds changes the Markdown store lacks (local edits
   * merged in, or content that differs from `known`), which the writer snapshots.
   */
  markBound(dirty: boolean) {
    this.bound = true;
    this.dirtySinceSnapshot = dirty;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    if (dirty && this.status === 'connected' && this.isSnapshotWriter()) this.scheduleSnapshot();
    this.notify();
  }

  /** Saves the room's Markdown on `known`'s revision; resolves once answered (after merging a refused one's newer save). */
  async writeSnapshot() {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    if (this.destroyed) return;
    const source = this.options.markdown();
    if (source === null) return;
    this.dirtySinceSnapshot = false;
    if (this.options.unchanged?.(source)) return;
    const blockIds = this.options.blockIds?.() ?? null;
    const baseRevision = this.known?.revision;
    let result;
    try {
      result = await this.options.api.saveDocumentContent(this.options.attachmentId, {
        mode: 'snapshot',
        source,
        ...(baseRevision === undefined ? {} : { baseRevision }),
        ...(blockIds ? { blockIds } : {}),
      });
    } catch {
      this.dirtySinceSnapshot = true;
      this.retrySnapshot();
      return;
    }
    if (this.destroyed) return;
    if (result.status === 'conflict') {
      this.dirtySinceSnapshot = true;
      this.conflicts += 1;
      if (this.conflicts <= MAX_CONFLICTS) await this.options.onConflict?.(result.document);
      return;
    }
    this.conflicts = 0;
    this.snapshotFailures = 0;
    const answered = knownDocument(result.document);
    if (!this.known || answered.revision >= this.known.revision) this.known = answered;
    if (!this.detached) this.options.onSnapshot?.(result.document);
  }

  /** 2, 5, 10 s, then every 10 s, while this editor stays connected and the writer; a reconnect's sync retries too. */
  private retrySnapshot() {
    if (this.destroyed || this.status !== 'connected') return;
    const delays = this.options.timing?.snapshotRetryMs ?? SNAPSHOT_RETRY_MS;
    this.scheduleSnapshot(delays[Math.min(this.snapshotFailures, delays.length - 1)]);
    this.snapshotFailures += 1;
  }

  /**
   * Leaves the room; nothing calls back into the editor after this. A bound room that is offline with edits made
   * since the connection dropped keeps reconnecting in the background (at most `CLOSE_LINGER_MS`) until a connection
   * syncs them, then snapshots if it is the writer. A connected writer with unsaved changes stays until its last
   * snapshot is answered, so a refused one can still merge the newer save in.
   */
  destroy() {
    if (this.detached) return;
    this.detached = true;
    const offlineEdits = this.bound && this.status !== 'connected' && this.offlineEdits;
    const lastSnapshot = this.status === 'connected' && this.isSnapshotWriter() && this.dirtySinceSnapshot;
    if (!offlineEdits && !lastSnapshot) {
      this.teardown();
      return;
    }
    this.lingering = true;
    closingRooms.add(this);
    this.provider?.awareness.setLocalState(null);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    this.closeTimer = setTimeout(() => this.teardown(), this.options.timing?.closeLingerMs ?? CLOSE_LINGER_MS);
    if (lastSnapshot) void this.settle();
  }

  private async settle() {
    if (this.settling) return;
    this.settling = true;
    await this.writeSnapshot();
    this.teardown();
  }

  private teardown() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lingering = false;
    closingRooms.delete(this);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.ydoc.off('update', this.onUpdate);
    if (this.provider) {
      this.provider.off('sync', this.onSync);
      this.provider.off('connection-close', this.onClose);
      this.provider.awareness.off('change', this.onAwareness);
      this.provider.destroy();
    }
    this.ydoc.destroy();
  }
}
