import type { Page } from '@playwright/test';

/** Jumps to the first step of a tour section through the tour's own section list. */
export async function openSection(page: Page, name: string) {
  await page.getByRole('button', { name: 'Tour sections', exact: true }).click();
  await page.getByRole('navigation', { name: 'Tour sections' }).getByRole('button', { name, exact: true }).click();
}

/** The whole walkthrough on a desktop runtime, in order. */
export const TOUR_TARGETS = [
  'nav-contacts', 'nav-chats', 'nav-agent-chats', 'nav-agents', 'nav-digest',
  'settings-auth',
  'settings-memory', 'memory-import-files', 'memory-import-run', 'memory-review',
  'grounding', 'grounding-cards', 'grounding-new-card',
  'grounding-memory', 'grounding-documents', 'grounding-connectors', 'grounding-device', 'grounding-links', 'grounding-notes', 'grounding-build',
  'grounding-topics', 'grounding-sharing',
  'grounding-pair', 'grounding-room', 'grounding-room-people', 'grounding-room-topics',
  'chat-export',
  'help',
] as const;
/** The Help menu's "Create and share cards" and "Meet people with Grounding" parts. */
export const CARD_TARGETS = TOUR_TARGETS.slice(10, 22);
export const MEET_TARGETS = TOUR_TARGETS.slice(22, 26);
