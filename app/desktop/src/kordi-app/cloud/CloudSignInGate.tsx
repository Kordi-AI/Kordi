import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  probeBrowserSignIn,
  type BrowserSignInAvailability,
  type BrowserSignInIntent,
} from '@/features/cloud/appSignIn/appSignInClient';
import type { CloudBrowserSignInSession } from '@/features/cloud/appSignIn/cloudBrowserSignInSession';
import { useBrowserSignIn, type BrowserSignInState } from '@/features/cloud/appSignIn/useBrowserSignIn';

import { CloudBrowserSignInPage, type CloudSignInNotice } from './CloudBrowserSignInPage';

// Signed out, the app shows the welcome screen and signs in through the
// system browser; it has no sign-in form of its own. When this window cannot
// run browser sign-in, or the server reports it unavailable, the welcome
// screen stays with an error line, and Log in and Sign up stay enabled so
// the person can try again.

const SIGN_IN_UNAVAILABLE_ON_SERVER = 'Sign-in is unavailable on this server.';
const SIGN_IN_UNAVAILABLE_IN_WINDOW = 'Sign-in is unavailable in this window.';

const knownAvailable = new Set<string>();

function availabilityKey(session: CloudBrowserSignInSession): string {
  return `${session.config.baseUrl} ${session.config.clientId}`;
}

/**
 * Whether the server offers browser sign-in for this app. Only `available`
 * is remembered, so an unavailable or inconclusive answer is asked again on
 * the next attempt. The answer never hides or disables Log in and Sign up.
 */
function useBrowserSignInAvailability(session: CloudBrowserSignInSession) {
  const key = availabilityKey(session);
  const [availability, setAvailability] = useState<BrowserSignInAvailability | 'checking'>(
    () => (knownAvailable.has(key) ? 'available' : 'checking'),
  );
  const probeRef = useRef<Promise<BrowserSignInAvailability> | null>(null);
  const probe = useCallback((): Promise<BrowserSignInAvailability> => {
    if (knownAvailable.has(key)) return Promise.resolve('available');
    if (!probeRef.current) {
      // Asking again clears a standing error until the answer arrives.
      setAvailability((current) => (current === 'unavailable' ? 'checking' : current));
      probeRef.current = probeBrowserSignIn(session.config).then((result) => {
        probeRef.current = null;
        if (result === 'available') knownAvailable.add(key);
        setAvailability(result);
        return result;
      });
    }
    return probeRef.current;
  }, [key, session.config]);
  useEffect(() => { void probe(); }, [probe]);
  return { availability, probe };
}

function BrowserSignIn({ session }: { session: CloudBrowserSignInSession }) {
  const signIn = useBrowserSignIn({ config: session.config, onSignedIn: session.complete });
  const { availability, probe } = useBrowserSignInAvailability(session);
  const { start } = signIn;
  // Each attempt settles availability first, so a server that starts
  // offering browser sign-in is picked up without a relaunch.
  const startWhenAvailable = useCallback<BrowserSignInState['start']>(async (intent: BrowserSignInIntent) => {
    if ((await probe()) !== 'unavailable') await start(intent);
  }, [probe, start]);
  const notice = useMemo<CloudSignInNotice | null>(() => (
    availability === 'unavailable'
      ? { message: SIGN_IN_UNAVAILABLE_ON_SERVER, onRetry: () => { void probe(); } }
      : null
  ), [availability, probe]);
  return <CloudBrowserSignInPage signIn={{ ...signIn, start: startWhenAvailable }} notice={notice} />;
}

const noop = () => {};
const resolved = () => Promise.resolve();
const WINDOW_NOTICE: CloudSignInNotice = { message: SIGN_IN_UNAVAILABLE_IN_WINDOW };

/** A window that cannot run browser sign-in: a browser preview, or a build without an API origin. */
function BrowserSignInUnavailable() {
  const [error, setError] = useState<string | null>(null);
  const signIn: BrowserSignInState = {
    phase: 'welcome',
    error,
    codeError: null,
    submittingCode: false,
    // Log in and Sign up repeat the line as an alert.
    start: () => {
      setError(SIGN_IN_UNAVAILABLE_IN_WINDOW);
      return Promise.resolve();
    },
    reopenBrowser: noop,
    cancel: noop,
    submitCode: resolved,
  };
  return <CloudBrowserSignInPage signIn={signIn} notice={WINDOW_NOTICE} />;
}

export function CloudSignInGate({ browserSignIn }: { browserSignIn?: CloudBrowserSignInSession }) {
  return browserSignIn ? <BrowserSignIn session={browserSignIn} /> : <BrowserSignInUnavailable />;
}
