import { useEffect, useSyncExternalStore } from 'react';
import { CLAIM_UID_PREFIX, contentFingerprint, DIGEST_CALENDAR_SERVER_CHANGED_EVENT, notifyCalendarSync, planCalendarSync, syncWindow, type DeviceWrite, type SyncBaseline } from './calendarSync';
import { CALENDAR_SYNC_PREFERENCES_EVENT, readCalendarSyncBaseline, readCalendarSyncInstallationId, readCalendarSyncPreferences, writeCalendarSyncBaseline, type CalendarSyncPreferences } from './calendarSyncPreferences';
import { connectedCalendars, deleteDeviceEvent, deviceCalendarAccess, readDeviceEvents, watchDeviceCalendar, writeDeviceEvent, type DeviceEventTarget } from './calendar';
import { calendarErrorMessage } from './calendarImport';
import { digestClient } from './client';
import { isNativeDesktopShell } from '@/lib/desktop';
import type { CalendarConnection, CalendarEvent, CalendarSyncResult, DeviceCalendarAccess, DeviceCalendarEvent } from './types';

export type CalendarSyncStatus = {
  phase: 'idle' | 'syncing' | 'synced' | 'error' | 'permission' | 'unavailable';
  permission: DeviceCalendarAccess;
  calendars: CalendarConnection[];
  lastSyncedAt: string | null;
  error: string | null;
  /** Events this device currently keeps in sync. */
  syncedCount: number;
  /** True while macOS has not been asked and an in-app request can still show its prompt. */
  canRequest: boolean;
};
export type CalendarSyncDeps = {
  isNative: () => boolean;
  access: (request: boolean) => Promise<DeviceCalendarAccess>;
  calendars: () => Promise<CalendarConnection[]>;
  readEvents: (calendarIds: string[], from: string, to: string) => Promise<DeviceCalendarEvent[]>;
  writeEvent: (event: CalendarEvent, options: { deviceId?: string | null; calendarId?: string | null; deviceStartAt?: string | null }) => Promise<{ deviceId: string; externalUid: string }>;
  deleteEvent: (target: DeviceEventTarget) => Promise<void>;
  watch: (onChange: () => void) => Promise<() => void>;
  serverEvents: (accountId: string) => Promise<CalendarEvent[]>;
  serverSync: (accountId: string, changes: { upserts: CalendarEvent[]; deletes: { id: string; revision: number }[] }) => Promise<CalendarSyncResult>;
  preferences: (accountId: string) => CalendarSyncPreferences;
  installationId: (accountId: string) => string;
  readBaseline: (accountId: string) => SyncBaseline;
  writeBaseline: (accountId: string, baseline: SyncBaseline) => void;
  afterServerChange: (accountId: string) => Promise<unknown>;
  now: () => number;
};
export const CALENDAR_SYNC_INTERVAL_MS = 15 * 60_000;
export const CALENDAR_SYNC_DEBOUNCE_MS = 1_500;
export const CALENDAR_SYNC_FOREGROUND_MIN_MS = 30_000;
export const CALENDAR_ACCESS_REQUEST_EVENT = 'kordi:digest-calendar-access-request';
const MAX_CALENDARS = 50;
const MAX_SYNC_ITEMS = 500;
const MAX_SYNC_BYTES = 512 * 1024;

/** Leave room for the request envelope below the API body limit. */
function syncBatches<T>(items: T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [], bytes = 0;
  const encoder = new TextEncoder();
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).length + 1;
    if (batch.length && (batch.length === MAX_SYNC_ITEMS || bytes + size > MAX_SYNC_BYTES)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(item); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export const defaultCalendarSyncDeps: CalendarSyncDeps = {
  isNative: isNativeDesktopShell,
  access: deviceCalendarAccess,
  calendars: connectedCalendars,
  readEvents: readDeviceEvents,
  writeEvent: writeDeviceEvent,
  deleteEvent: deleteDeviceEvent,
  watch: watchDeviceCalendar,
  serverEvents: async accountId => (await digestClient.calendar(accountId)).events,
  serverSync: (accountId, changes) => digestClient.sync(accountId, changes),
  preferences: readCalendarSyncPreferences,
  installationId: readCalendarSyncInstallationId,
  readBaseline: readCalendarSyncBaseline,
  writeBaseline: writeCalendarSyncBaseline,
  afterServerChange: async accountId => (await import('./store')).digestStoreFor(accountId).refresh(true),
  now: Date.now,
};

export class CalendarPermissionError extends Error {
  constructor(readonly permission: DeviceCalendarAccess) { super('Calendar access is off.'); }
}

const initialStatus = (): CalendarSyncStatus => ({ phase: 'idle', permission: 'notDetermined', calendars: [], lastSyncedAt: null, error: null, syncedCount: 0, canRequest: false });
class CalendarSyncStore {
  private state = initialStatus();
  private listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** Unchanged fields never notify, so a repeated check cannot re-render the status line. */
  publish(patch: Partial<CalendarSyncStatus>) {
    const current = this.state as Record<string, unknown>;
    if (Object.entries(patch).every(([key, value]) => Object.is(current[key], value))) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  reset() { this.publish(initialStatus()); }
}
const stores = new Map<string, CalendarSyncStore>();
export function calendarSyncStoreFor(accountId: string) {
  let store = stores.get(accountId);
  if (!store) { store = new CalendarSyncStore(); stores.set(accountId, store); }
  return store;
}

/**
 * Reads calendar permission. Only an explicit person action may pass `request`: a request that macOS
 * refuses to show (for example when another process is responsible for the app) leaves the status
 * "not determined" and posts a store change, so asking from automatic runs would loop.
 */
export async function calendarPermission(deps: Pick<CalendarSyncDeps, 'access'>, request = false): Promise<DeviceCalendarAccess> {
  const permission = await deps.access(false);
  return permission === 'notDetermined' && request ? deps.access(true) : permission;
}

/** One full reconciliation. Device writes happen first so their identities can be recorded server-side during reconciliation. */
export async function syncDeviceCalendarOnce(accountId: string, deps: CalendarSyncDeps, onCalendars?: (calendars: CalendarConnection[], permission: DeviceCalendarAccess) => void, options: { request?: boolean; permission?: DeviceCalendarAccess } = {}): Promise<{ calendars: CalendarConnection[]; permission: DeviceCalendarAccess; syncedCount: number; changed: boolean }> {
  const permission = options.permission ?? await calendarPermission(deps, options.request);
  if (permission !== 'granted') throw new CalendarPermissionError(permission);
  const calendars = (await deps.calendars()).slice(0, MAX_CALENDARS);
  onCalendars?.(calendars, permission);
  const preferences = deps.preferences(accountId);
  const now = new Date(deps.now());
  const { from, to } = syncWindow(now);
  const included = calendars.filter(calendar => !preferences.excludedCalendarIds.includes(calendar.id));
  const device = included.length ? await deps.readEvents(included.map(calendar => calendar.id), from, to) : [];
  const server = await deps.serverEvents(accountId);
  const baseline = deps.readBaseline(accountId);
  const installationId = deps.installationId(accountId);
  const plan = planCalendarSync({ device, server, baseline, installationId, excludedCalendarIds: preferences.excludedCalendarIds, readOnlyCalendarIds: calendars.filter(calendar => calendar.allowsModifications === false).map(calendar => calendar.id), outbound: { enabled: preferences.outbound, calendarId: preferences.targetCalendarId }, now });
  const deviceByUid = new Map(device.map(item => [item.externalUid, item]));
  // Keep unsettled revisions across partial failures, especially pending deletions.
  const pendingIds = new Set([...plan.upserts, ...plan.deletes, ...plan.deviceWrites.map(write => write.event)].map(event => event.id));
  const next: SyncBaseline = { ...Object.fromEntries(Object.entries(baseline).filter(([, entry]) => pendingIds.has(entry.serverId))), ...plan.baseline };
  const settle = (event: CalendarEvent, calendarId?: string, uid = plan.deviceUidByServerId[event.id] ?? event.externalUid) => {
    if (!uid?.startsWith('device:')) return;
    next[uid] = { serverId: event.id, fingerprint: contentFingerprint(event), revision: event.revision, calendarId: calendarId ?? deviceByUid.get(uid)?.calendarId ?? next[uid]?.calendarId };
  };
  const problems: string[] = [];
  for (const removal of plan.deviceDeletes) {
    try { await deps.deleteEvent(removal); } catch (error) { problems.push(calendarErrorMessage(error, 'Could not remove an event from the device calendar.')); }
  }
  let changed = false;
  const writes: DeviceWrite[] = [...plan.deviceWrites];
  for (const claims of syncBatches(plan.claims)) {
    // Only the device whose claim lands (the revision check) copies the event, so two devices never both write it.
    const claimed = await deps.serverSync(accountId, { upserts: claims.map(event => ({ ...event, externalUid: CLAIM_UID_PREFIX + installationId })), deletes: [] });
    for (const won of claimed.saved) writes.push({ event: won, calendarId: preferences.targetCalendarId ?? null });
    changed = changed || claimed.saved.length > 0;
  }
  const upserts = [...plan.upserts];
  for (const write of writes) {
    try {
      const written = await deps.writeEvent(write.event, { deviceId: write.deviceId, calendarId: write.calendarId, deviceStartAt: write.deviceStartAt });
      if (write.event.externalUid === written.externalUid) settle(write.event, write.calendarId ?? undefined);
      else {
        // Record the device identity before anything else can create a second copy.
        next[written.externalUid] = { serverId: write.event.id, fingerprint: contentFingerprint(write.event), revision: write.event.revision, calendarId: write.calendarId ?? undefined };
        plan.deviceUidByServerId[write.event.id] = written.externalUid;
        upserts.push({ ...write.event, externalUid: written.externalUid });
      }
    } catch (error) { problems.push(calendarErrorMessage(error, 'Could not write an event to the device calendar.')); }
  }
  // Persist device-side effects before the server call, so a failed request never turns a new device copy into a duplicate.
  deps.writeBaseline(accountId, next);
  // One row per id per batch: a later upsert for the same id wins, and an id that is being written is never also deleted.
  const uniqueUpserts = [...new Map(upserts.map(event => [event.id, event])).values()];
  const upsertIds = new Set(uniqueUpserts.map(event => event.id));
  const deleteIds = new Set<string>();
  const deletes = plan.deletes.filter(event => !upsertIds.has(event.id) && !deleteIds.has(event.id) && deleteIds.add(event.id));
  // Release capacity first. Persist every acknowledged batch before starting the next.
  const batches = [
    ...syncBatches(deletes).map(deletes => ({ upserts: [] as CalendarEvent[], deletes })),
    ...syncBatches(uniqueUpserts).map(upserts => ({ upserts, deletes: [] as CalendarEvent[] })),
  ];
  try {
    for (const batch of batches) {
      const result = await deps.serverSync(accountId, { upserts: batch.upserts, deletes: batch.deletes.map(event => ({ id: event.id, revision: event.revision })) });
      for (const saved of result.saved) settle(saved);
      const removed = new Set(result.deleted);
      for (const [uid, entry] of Object.entries(next)) if (removed.has(entry.serverId)) delete next[uid];
      changed = changed || result.saved.length > 0 || result.deleted.length > 0;
      if (result.skipped.length) problems.push('Your Kordi calendar is full. Some events were not synced. Turn off a calendar in Calendar settings to free space.');
      deps.writeBaseline(accountId, { ...next });
    }
  } finally {
    if (changed) { try { await deps.afterServerChange(accountId); } catch { /* The digest route re-reads on its own poll. */ } }
  }
  deps.writeBaseline(accountId, next);
  if (problems.length) throw new Error(problems[0]);
  return { calendars, permission, syncedCount: Object.keys(next).length, changed };
}

/**
 * Keeps the device calendar and the Kordi calendar converged for as long as the shell is open.
 * Automatic runs (start, timer, focus, device changes) only read the permission; the macOS prompt
 * is shown only from `requestCalendarAccess`. The device observer runs only while access is granted.
 */
export function scheduleCalendarSync(accountId: string, deps: CalendarSyncDeps = defaultCalendarSyncDeps): () => void {
  const store = calendarSyncStoreFor(accountId);
  if (!deps.isNative()) { store.publish({ phase: 'unavailable', permission: 'unavailable' }); return () => {}; }
  let stopped = false, running = false, queued = false, queuedRequest = false, lastForeground = 0;
  // Set once a request in this session left the status undetermined: macOS will not prompt this process.
  let cannotAsk = false;
  let debounce: ReturnType<typeof setTimeout> | undefined, unwatch: (() => void) | null = null, watching = false, watchGeneration = 0;
  const startWatching = () => {
    if (watching) return;
    watching = true;
    const generation = ++watchGeneration;
    void deps.watch(trigger).then(stop => { if (stopped || generation !== watchGeneration) stop(); else unwatch = stop; }).catch(() => {
      if (generation === watchGeneration) watching = false; /* Polling and foreground syncs still run without the observer. */
    });
  };
  const stopWatching = () => { watching = false; watchGeneration++; unwatch?.(); unwatch = null; };
  const run = async (request = false) => {
    if (stopped) return;
    if (running) { queued = true; queuedRequest = queuedRequest || request; return; }
    running = true;
    try {
      const permission = await calendarPermission(deps, request);
      if (stopped) return;
      if (request && permission === 'notDetermined') cannotAsk = true;
      if (permission !== 'granted') {
        stopWatching();
        store.publish({ phase: 'permission', permission, error: null, canRequest: permission === 'notDetermined' && !cannotAsk });
        return;
      }
      startWatching();
      // A background pass after a successful sync keeps the synced line instead of flashing "Syncing".
      if (store.getSnapshot().phase !== 'synced') store.publish({ phase: 'syncing', permission, error: null, canRequest: false });
      const result = await syncDeviceCalendarOnce(accountId, deps, (calendars, permission) => {
        if (!stopped) store.publish({ calendars, permission });
      }, { permission });
      if (!stopped) store.publish({ phase: 'synced', permission: result.permission, calendars: result.calendars, lastSyncedAt: new Date(deps.now()).toISOString(), syncedCount: result.syncedCount, error: null, canRequest: false });
    } catch (error) {
      if (stopped) return;
      if (error instanceof CalendarPermissionError) { stopWatching(); store.publish({ phase: 'permission', permission: error.permission, error: null, canRequest: error.permission === 'notDetermined' && !cannotAsk }); }
      else store.publish({ phase: 'error', error: calendarErrorMessage(error, 'Calendar sync failed.') });
    } finally {
      running = false;
      if (queued && !stopped) { const again = queuedRequest; queued = false; queuedRequest = false; void run(again); }
    }
  };
  const trigger = () => { if (stopped) return; clearTimeout(debounce); debounce = setTimeout(() => void run(), CALENDAR_SYNC_DEBOUNCE_MS); };
  const foreground = () => {
    if (document.hidden) return;
    // Returning from System Settings with access still off is a cheap status read, so it is never throttled.
    if (store.getSnapshot().phase !== 'permission' && deps.now() - lastForeground < CALENDAR_SYNC_FOREGROUND_MIN_MS) return;
    lastForeground = deps.now();
    trigger();
  };
  const forThisAccount = (event: Event) => (event as CustomEvent<{ accountId?: string }>).detail?.accountId === accountId;
  const onPreferences = (event: Event) => { if (forThisAccount(event)) trigger(); };
  const onAccessRequest = (event: Event) => { if (forThisAccount(event)) { clearTimeout(debounce); void run(true); } };
  trigger();
  // The tick runs even while the window is hidden: a background Kordi must still carry Kordi-created events to the device calendar.
  const interval = setInterval(trigger, CALENDAR_SYNC_INTERVAL_MS);
  window.addEventListener('focus', foreground);
  document.addEventListener('visibilitychange', foreground);
  window.addEventListener(CALENDAR_SYNC_PREFERENCES_EVENT, onPreferences);
  window.addEventListener(DIGEST_CALENDAR_SERVER_CHANGED_EVENT, onPreferences);
  window.addEventListener(CALENDAR_ACCESS_REQUEST_EVENT, onAccessRequest);
  return () => {
    stopped = true;
    clearTimeout(debounce);
    clearInterval(interval);
    stopWatching();
    window.removeEventListener('focus', foreground);
    document.removeEventListener('visibilitychange', foreground);
    window.removeEventListener(CALENDAR_SYNC_PREFERENCES_EVENT, onPreferences);
    window.removeEventListener(DIGEST_CALENDAR_SERVER_CHANGED_EVENT, onPreferences);
    window.removeEventListener(CALENDAR_ACCESS_REQUEST_EVENT, onAccessRequest);
    store.reset();
  };
}

export function useCalendarSync(accountId?: string | null) {
  useEffect(() => accountId ? scheduleCalendarSync(accountId) : undefined, [accountId]);
}
const emptyStore = new CalendarSyncStore();
export function useCalendarSyncStatus(accountId?: string | null): CalendarSyncStatus {
  const store = accountId ? calendarSyncStoreFor(accountId) : emptyStore;
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
/** Lets the Digest page ask for an immediate reconciliation after an in-app edit. */
export function requestCalendarSync(accountId: string) {
  notifyCalendarSync(CALENDAR_SYNC_PREFERENCES_EVENT, accountId);
}
/** Shows the macOS calendar prompt from a person's action, then syncs when access is granted. */
export function requestCalendarAccess(accountId: string) {
  notifyCalendarSync(CALENDAR_ACCESS_REQUEST_EVENT, accountId);
}
