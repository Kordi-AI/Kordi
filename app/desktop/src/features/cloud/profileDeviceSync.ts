import { invokeDesktop, isNativeDesktopShell } from '@/lib/desktop';
import { isMacPlatform } from '@/features/connectors/connectorsClient';

import type { CloudAccount } from './cloudIdentityTypes';

/**
 * Automatic profile Location and Time zone (#2439). This device reports what
 * it observes; the server writes a field only while its mode is automatic.
 * A device sends only values it saw change, so a desk Mac that never moved
 * does not overwrite the city a travelling iPhone reported.
 */

/** What this device reports; only city names, never coordinates. */
export type ProfileDeviceObservation = { timeZone?: string | null; location?: string | null };
export type ProfileDeviceBody = { timeZone?: string; location?: string };

/** What this device last observed, per account. */
export type ProfileDeviceMemory = {
  timeZone?: string;
  location?: string;
  /** When this device last looked up its city (ms). */
  locationCheckedAt?: number;
};

/** A city lookup at most this often, except at launch and when turned on. */
export const PROFILE_CITY_INTERVAL_MS = 30 * 60_000;
/** How often the time zone is compared; reading it is cheap. */
export const PROFILE_TIME_ZONE_INTERVAL_MS = 60_000;

const STORAGE_PREFIX = 'kordi.profileDeviceSync.v1.';

type Field = 'timeZone' | 'location';
const MODE_KEY = { timeZone: 'timeZoneMode', location: 'locationMode' } as const;

/**
 * Which observed values to send. A first observation on this device only
 * fills an empty field; after that, a value is sent when this device saw it
 * change and the account does not already hold it.
 */
export function profileDeviceUpdate(
  account: Pick<CloudAccount, 'timeZone' | 'location' | 'timeZoneMode' | 'locationMode'>,
  observed: ProfileDeviceObservation,
  memory: ProfileDeviceMemory,
): { body: ProfileDeviceBody; memory: ProfileDeviceMemory } {
  const body: ProfileDeviceBody = {};
  const next: ProfileDeviceMemory = { ...memory };
  for (const field of ['timeZone', 'location'] as Field[]) {
    const value = observed[field]?.trim();
    if (!value) continue;
    const previous = memory[field];
    next[field] = value;
    if (account[MODE_KEY[field]] !== 'automatic' || value === previous) continue;
    const current = account[field]?.trim() || '';
    if (value === current) continue;
    if (previous === undefined && current) continue;
    body[field] = value;
  }
  return { body, memory: next };
}

/** Whether this device should look up its city now. */
export function profileCityDue(
  account: Pick<CloudAccount, 'locationMode'>,
  memory: ProfileDeviceMemory,
  now: number,
  force = false,
): boolean {
  if (account.locationMode !== 'automatic') return false;
  const last = memory.locationCheckedAt;
  return force || last === undefined || now < last || now - last >= PROFILE_CITY_INTERVAL_MS;
}

export function loadProfileDeviceMemory(accountId: string): ProfileDeviceMemory {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_PREFIX + accountId) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const value = parsed as Record<string, unknown>;
    return {
      ...(typeof value.timeZone === 'string' ? { timeZone: value.timeZone } : {}),
      ...(typeof value.location === 'string' ? { location: value.location } : {}),
      ...(typeof value.locationCheckedAt === 'number' ? { locationCheckedAt: value.locationCheckedAt } : {}),
    };
  } catch {
    return {};
  }
}

export function saveProfileDeviceMemory(accountId: string, memory: ProfileDeviceMemory) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + accountId, JSON.stringify(memory));
  } catch {
    // A device that cannot remember only sends again later.
  }
}

/** True in the Mac app, where Core Location can name this Mac's city. */
export function deviceCityAvailable(): boolean {
  return isNativeDesktopShell() && isMacPlatform();
}

/** The system time zone; the Mac app reads it fresh, a browser asks Intl. */
export async function deviceTimeZone(): Promise<string | null> {
  if (deviceCityAvailable()) {
    const zone = await invokeDesktop<string | null>('desktop_time_zone').catch(() => null);
    if (zone) return zone;
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * This Mac's city. With `prompt`, asks for location access first when it was
 * never asked for. Rejects with a location failure code such as `location_denied`.
 */
export function deviceCity(prompt = false): Promise<string> {
  return invokeDesktop<string>('desktop_profile_city', { prompt });
}

/**
 * Location access for this app: 'granted', 'not_determined', 'denied', 'restricted' or 'unavailable'.
 * Failures reject with a location failure code and are logged as "[profile-location]".
 */
export function deviceLocationPermission(request: boolean): Promise<string> {
  return invokeDesktop<string>('desktop_profile_location_permission', { request });
}

export const LOCATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices';
