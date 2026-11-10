import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Navigation } from 'lucide-react';

import { CloudProfileFieldRow } from '@/kordi-app/cloud/CloudProfileFieldRow';
import type { CloudAccount } from '@/features/cloud/authClient';
import {
  LOCATION_SETTINGS_URL,
  deviceCity,
  deviceCityAvailable,
  deviceLocationPermission,
} from '@/features/cloud/profileDeviceSync';
import { openDesktopExternalUrl } from '@/lib/desktop';
import { refreshDesktopTimeZone } from '@/lib/time';
import {
  CLOUD_PROFILE_LIMITS,
  cloudProfileDeviceOwned,
  cloudProfileFieldDraft,
  timeZoneOptionLabel,
  timeZoneOptions,
} from './cloudProfileDraft';
import type { CloudProfileEditor } from './useCloudProfileEditor';

/** This device's location access, replaceable in tests. */
export type ProfileDeviceLocation = {
  permission: (request: boolean) => Promise<string>;
  city: () => Promise<string>;
  openSettings: () => void;
};

const nativeDeviceLocation: ProfileDeviceLocation = {
  permission: deviceLocationPermission,
  city: deviceCity,
  openSettings: () => { void openDesktopExternalUrl(LOCATION_SETTINGS_URL); },
};

const blocked = (status: string) => status === 'denied' || status === 'restricted';

function AutomaticMark() {
  return (
    <>
      <Navigation aria-hidden="true" className="h-2.5 w-2.5 fill-current" />
      Automatic
    </>
  );
}

/**
 * Location and Time zone rows. Each follows this device while automatic; typing
 * or picking a value makes it manual, and the arrow turns automatic back on.
 */
export function CloudProfileAutoRows({ account, editor, id, deviceLocation }: {
  account: CloudAccount;
  editor: CloudProfileEditor;
  id: (name: string) => string;
  /** Defaults to Core Location in the Mac app; absent elsewhere. */
  deviceLocation?: ProfileDeviceLocation | null;
}) {
  const { fieldDraft, errors } = editor;
  const location = deviceLocation === undefined ? (deviceCityAvailable() ? nativeDeviceLocation : null) : deviceLocation;
  const saved = cloudProfileFieldDraft(account);
  const locationAuto = fieldDraft.locationMode === 'automatic';
  const timeZoneAuto = fieldDraft.timeZoneMode === 'automatic';
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [permission, setPermission] = useState<string | null>(null);
  const zones = useMemo(() => timeZoneOptions(), []);
  const deviceZone = refreshDesktopTimeZone();

  useEffect(() => {
    if (!location || !locationAuto) return;
    let cancelled = false;
    const check = () => {
      void location.permission(false).then((status) => { if (!cancelled) setPermission(status); }).catch(() => undefined);
    };
    check();
    window.addEventListener('focus', check);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', check);
    };
  }, [location, locationAuto]);

  // While automatic on both sides, the value shown is the device's latest.
  const locationValue = cloudProfileDeviceOwned('location', fieldDraft, saved) ? saved.location : fieldDraft.location;
  const shownZone = timeZoneAuto
    ? (cloudProfileDeviceOwned('timeZone', fieldDraft, saved) && saved.timeZone) || deviceZone
    : fieldDraft.timeZone;

  const typeLocation = (value: string) => {
    setLocationError(null);
    editor.setField('location', value);
    if (locationAuto) editor.setField('locationMode', 'manual');
  };

  const turnOnLocation = async () => {
    if (!location || locating) return;
    setLocationError(null);
    try {
      const status = await location.permission(true);
      setPermission(status);
      if (blocked(status)) {
        // The person's choice stays; the row explains how to allow access.
        editor.setField('locationMode', 'automatic');
        return;
      }
      if (status !== 'granted') return;
      setLocating(true);
      const city = await location.city();
      editor.setField('location', city);
      editor.setField('locationMode', 'automatic');
    } catch {
      setLocationError('Could not find your city.');
    } finally {
      setLocating(false);
    }
  };

  const chooseTimeZone = (value: string) => {
    editor.setField('timeZoneMode', value ? 'manual' : 'automatic');
    editor.setField('timeZone', value || deviceZone);
  };

  const showSettingsLine = locationAuto && Boolean(location) && permission !== null && blocked(permission);
  const locationErrorText = errors.location ?? locationError ?? undefined;
  return (
    <>
      <CloudProfileFieldRow
        label="Location"
        htmlFor={id('location')}
        error={locationErrorText}
        errorId={id('location-error')}
        invalid={Boolean(locationErrorText)}
        below={showSettingsLine ? (
          <button type="button" className="app-cloud-profile-line-link" onClick={() => location?.openSettings()}>
            Allow location in System Settings
          </button>
        ) : undefined}
      >
        <input
          id={id('location')}
          value={locating ? '' : locationValue}
          readOnly={locating}
          maxLength={CLOUD_PROFILE_LIMITS.location}
          onChange={(event) => typeLocation(event.currentTarget.value)}
          className="app-cloud-profile-input"
          placeholder={locating ? 'Locating…' : 'Add your location'}
          aria-invalid={Boolean(locationErrorText) || undefined}
          aria-describedby={locationErrorText ? id('location-error') : undefined}
        />
        {locationAuto ? (
          <button
            type="button"
            className="app-cloud-profile-auto"
            title="Turn off automatic location"
            aria-label="Automatic location on"
            aria-pressed="true"
            onClick={() => editor.setField('locationMode', 'manual')}
          >
            <AutomaticMark />
          </button>
        ) : location ? (
          <button
            type="button"
            className="app-cloud-profile-use-auto"
            title="Set automatically"
            aria-label="Set location automatically"
            disabled={locating}
            onClick={() => { void turnOnLocation(); }}
          >
            <Navigation aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </CloudProfileFieldRow>
      <CloudProfileFieldRow label="Time zone" htmlFor={id('time-zone')} error={errors.timeZone} errorId={id('time-zone-error')} invalid={Boolean(errors.timeZone)}>
        <span className="app-cloud-profile-select-value" aria-hidden="true">
          {shownZone ? timeZoneOptionLabel(shownZone) : 'Automatic'}
        </span>
        {timeZoneAuto ? <span className="app-cloud-profile-auto app-cloud-profile-auto-static" aria-hidden="true"><AutomaticMark /></span> : null}
        <ChevronDown aria-hidden="true" className="app-cloud-profile-select-chevron h-3.5 w-3.5 shrink-0" />
        <select
          id={id('time-zone')}
          value={timeZoneAuto ? '' : fieldDraft.timeZone}
          onChange={(event) => chooseTimeZone(event.currentTarget.value)}
          className="app-cloud-profile-select-overlay"
          aria-invalid={Boolean(errors.timeZone) || undefined}
        >
          <option value="">{`Automatic · ${timeZoneOptionLabel(deviceZone)}`}</option>
          {!timeZoneAuto && fieldDraft.timeZone && !zones.some((zone) => zone.value === fieldDraft.timeZone)
            ? <option value={fieldDraft.timeZone}>{fieldDraft.timeZone}</option>
            : null}
          {zones.map((zone) => <option key={zone.value} value={zone.value}>{zone.label}</option>)}
        </select>
      </CloudProfileFieldRow>
    </>
  );
}
