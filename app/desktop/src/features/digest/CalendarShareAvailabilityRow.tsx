import { useEffect, useMemo, useRef, useState } from 'react';

import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';

import {
  createCalendarShareClient,
  SHARE_AVAILABILITY_CAPTION,
  SHARE_AVAILABILITY_LABEL,
  SHARE_AVAILABILITY_SAVE_ERROR,
  type CalendarShareClient,
} from './calendarShareAvailability';

/**
 * Calendar settings: whether people in the owner's chats may ask the owner's
 * agent for busy/free times. Optimistic; a failed save restores the previous
 * value. Hidden on servers without the setting.
 */
export function CalendarShareAvailabilityRow({ client }: { client?: CalendarShareClient }) {
  const shareClient = useMemo(() => client ?? createCalendarShareClient(), [client]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    let cancelled = false;
    shareClient.get().then(
      (value) => { if (!cancelled) setEnabled(value); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [shareClient]);
  if (enabled === null) return null;
  const change = async (next: boolean) => {
    const previous = enabled;
    const attempt = ++latest.current;
    setEnabled(next);
    setError(null);
    try {
      await shareClient.set(next);
    } catch {
      if (attempt !== latest.current) return;
      setEnabled(previous);
      setError(SHARE_AVAILABILITY_SAVE_ERROR);
    }
  };
  return (
    <div className="digest-share-row">
      <div>
        <div className="digest-share-title">{SHARE_AVAILABILITY_LABEL}</div>
        <div className="digest-meta" aria-live="polite">{error ?? SHARE_AVAILABILITY_CAPTION}</div>
      </div>
      <SettingsSwitch enabled={enabled} label={SHARE_AVAILABILITY_LABEL} onChange={(next) => { void change(next); }} />
    </div>
  );
}
