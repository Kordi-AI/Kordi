import { isNativeDesktopShell } from '@/lib/desktop';

/** The Sign out row's line: the Mac app names the Mac, the browser app names no platform. */
export function signOutDescription(nativeShell: boolean = isNativeDesktopShell()): string {
  return nativeShell ? 'Sign out of Kordi on this Mac.' : 'Sign out of Kordi on this device.';
}
