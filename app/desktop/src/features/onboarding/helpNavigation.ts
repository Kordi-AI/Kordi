export const OPEN_GROUNDING_EVENT = 'kordi-help-open-grounding';
/** The Grounding screen a tour step shows. `room` is always an example room, never the account's own. */
export type HelpGroundingScreen = 'home' | 'build' | 'card' | 'room';
let pendingGroundingAccount: string | null = null;
let pendingScreen: { accountId: string; screen: HelpGroundingScreen } | null = null;

// Keep the intent until Contacts mounts; an event alone is lost during route changes.
export function requestHelpGrounding(accountId: string, screen?: HelpGroundingScreen) {
  pendingGroundingAccount = accountId;
  pendingScreen = screen ? { accountId, screen } : null;
  window.dispatchEvent(new Event(OPEN_GROUNDING_EVENT));
}

export function consumeHelpGrounding(accountId: string) {
  const matched = pendingGroundingAccount === accountId;
  pendingGroundingAccount = null;
  return matched;
}

export function hasHelpGrounding(accountId: string) {
  return pendingGroundingAccount === accountId;
}


export function consumeHelpGroundingScreen(accountId: string) {
  const screen = pendingScreen?.accountId === accountId ? pendingScreen.screen : null;
  pendingScreen = null;
  return screen;
}
