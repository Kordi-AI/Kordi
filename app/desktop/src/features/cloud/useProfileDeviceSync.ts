import { useEffect, useRef } from 'react';

import type { CloudAccount, CloudAuthClient } from './authClient';
import {
  PROFILE_TIME_ZONE_INTERVAL_MS,
  deviceCity,
  deviceCityAvailable,
  deviceTimeZone,
  loadProfileDeviceMemory,
  profileCityDue,
  profileDeviceUpdate,
  saveProfileDeviceMemory,
} from './profileDeviceSync';
import { loadSession } from './session';

/**
 * Keeps the signed-in account's automatic Location and Time zone in step with
 * this device: at launch, when the window comes back, and each minute for a
 * time zone change. Nothing is sent for manual fields or older servers.
 */
export function useProfileDeviceSync(
  account: CloudAccount | null,
  client: CloudAuthClient,
  onAccount: (next: CloudAccount) => void,
) {
  const accountRef = useRef(account);
  const onAccountRef = useRef(onAccount);
  useEffect(() => {
    accountRef.current = account;
    onAccountRef.current = onAccount;
  });
  const accountId = account?.accountId;
  const timeZoneMode = account?.timeZoneMode;
  const locationMode = account?.locationMode;

  useEffect(() => {
    if (!accountId || !timeZoneMode || !locationMode || typeof window === 'undefined') return;
    let cancelled = false;
    let running = false;
    let launched = false;

    const sync = async (checkCity: boolean) => {
      const current = accountRef.current;
      if (running || cancelled || current?.accountId !== accountId) return;
      running = true;
      try {
        let memory = loadProfileDeviceMemory(accountId);
        const now = Date.now();
        const lookUpCity = checkCity && deviceCityAvailable() && profileCityDue(current, memory, now, !launched);
        launched = true;
        const [timeZone, location] = await Promise.all([
          deviceTimeZone(),
          lookUpCity ? deviceCity().catch(() => null) : Promise.resolve(null),
        ]);
        if (lookUpCity) memory = { ...memory, locationCheckedAt: now };
        const latest = accountRef.current;
        if (cancelled || latest?.accountId !== accountId) return;
        const update = profileDeviceUpdate(latest, { timeZone, location }, memory);
        if (Object.keys(update.body).length > 0) {
          const session = await loadSession();
          if (!session?.token || cancelled) return;
          const next = await client.request<CloudAccount>('/v1/cloud/auth/me/device-profile', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
            body: JSON.stringify(update.body),
          }, 'Could not update your profile.');
          if (!cancelled && accountRef.current?.accountId === next.accountId) onAccountRef.current(next);
        }
        saveProfileDeviceMemory(accountId, update.memory);
      } catch {
        // Offline or rejected: the next launch, focus or minute tries again.
      } finally {
        running = false;
      }
    };

    void sync(true);
    const onFocus = () => { void sync(true); };
    const onVisible = () => { if (document.visibilityState === 'visible') void sync(true); };
    const interval = window.setInterval(() => { void sync(false); }, PROFILE_TIME_ZONE_INTERVAL_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [accountId, client, timeZoneMode, locationMode]);
}
