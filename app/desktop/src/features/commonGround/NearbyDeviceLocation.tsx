import { useState } from 'react';

import { ErrorLine } from '@/components/ui/ErrorLine';
import { isNativeDesktopShell, openDesktopExternalUrl } from '@/lib/desktop';
import { commonGroundErrorMessage } from './client';
import type { CgNearbyStore } from './storeNearby';
import { useNearbyLocation } from './useNearby';

/**
 * Any signed-in device can provide a fresh fix. While the Nearby screen is open and sharing, this
 * device also sends one by itself (foreground only, see `nearbyLocator`); the link is the manual
 * fallback, and the way back after a denied permission.
 */
export function NearbyDeviceLocation({ nearby }: { nearby: CgNearbyStore }) {
  const { busy, notice, settings } = useNearbyLocation(nearby);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const line = settingsNotice ?? notice;
  return (
    <div className="cg-nb-status cg-nb-location">
      <button type="button" className="cg-link" disabled={busy} onClick={() => { setSettingsNotice(null); void nearby.locator.locate(); }}>
        {busy ? 'Finding your location…' : 'Use this device’s location'}
      </button>
      <p>Nearby uses the most recent location from any of your signed-in devices.</p>
      {line ? <ErrorLine className="mt-0" role="status">{line}</ErrorLine> : null}
      {settings && isNativeDesktopShell() && /Mac/.test(navigator.platform) ? <button type="button" className="cg-link" onClick={() => void openDesktopExternalUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices').catch((error) => setSettingsNotice(commonGroundErrorMessage(error)))}>Location settings</button> : null}
    </div>
  );
}
