// After a build request gets no answer, the card store checks whether the build started anyway.

import type { CommonGroundClient } from './client';
import type { CgOwnerView } from './types';

/** Checks of the card after a build request got no answer. */
export const BUILD_START_CHECKS = 3;
export const BUILD_CHECK_MS = 2_000;

/**
 * Looks at the card a few times and returns it once it shows the build running, or null when it
 * never does or `current` turns false (the store closed, or another card was picked).
 */
export async function startedBuild(
  client: Pick<CommonGroundClient, 'card'>,
  profileId: string | null,
  current: () => boolean,
  checkMs = BUILD_CHECK_MS,
): Promise<CgOwnerView | null> {
  for (let check = 0; check < BUILD_START_CHECKS; check += 1) {
    if (check) await new Promise((resolve) => setTimeout(resolve, checkMs));
    if (!current()) return null;
    try {
      const owner = await client.card(profileId);
      if (!current()) return null;
      if (owner.build.status === 'building') return owner;
    } catch {
      // Still no answer; check again.
    }
  }
  return null;
}
