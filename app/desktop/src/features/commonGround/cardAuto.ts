// "Rebuild automatically" on the card page: the words of the meta line, and which topics a quiet
// update added. Pure, for tests.

import { cardTopics } from './cardReferences';
import { newMemoriesLine } from './storeMemories';
import { CG_TOPIC_SECTIONS, type CgOwnCard, type CgOwnerView } from './types';
import { shortDay } from './wallet';

/** The meta line in parts: "7 lines · built 14 Oct", then the new-memories count, then Auto or Updating. */
export type CgCardMeta = { base: string; newMemories: string | null; status: 'Auto' | 'Updating' | null };

/**
 * The card page's meta line. "Auto" ends it while the card rebuilds automatically; while an
 * automatic update runs, "Updating" takes the place of the new-memories count.
 */
export function cardMeta(
  card: CgOwnCard,
  owner: Pick<CgOwnerView, 'memoriesSinceBuild' | 'autoRebuild' | 'autoUpdating'>,
  countMemories: boolean,
  now = new Date(),
): CgCardMeta {
  const lineCount = CG_TOPIC_SECTIONS.reduce((sum, [key]) => sum + card[key].length, 0);
  const base = [`${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`, card.builtAt ? `built ${shortDay(card.builtAt, now)}` : ''].filter(Boolean).join(' · ');
  if (owner.autoUpdating) return { base, newMemories: null, status: 'Updating' };
  return { base, newMemories: countMemories ? newMemoriesLine(owner.memoriesSinceBuild) : null, status: owner.autoRebuild ? 'Auto' : null };
}

const fold = (topic: string) => topic.trim().toLowerCase();

/** Topics on `after` that `before` did not have, in card order; none when there was no card before. */
export function newTopics(before: CgOwnCard | null | undefined, after: CgOwnCard | null | undefined): string[] {
  if (!before || !after) return [];
  const known = new Set(cardTopics(before).map(fold));
  return cardTopics(after).filter((topic) => !known.has(fold(topic)));
}
