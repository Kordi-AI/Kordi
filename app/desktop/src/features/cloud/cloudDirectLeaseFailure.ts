// What the owner's Mac does when the server will not lease a direct-chat
// request for it to run (docs/contact-permissions.md).

import { isAgentUnavailableRefusal } from './agentRestrictions';

export type DirectLeaseFailureOptions = {
  /** The owner sent the request to their own agent. */
  ownRequest: boolean;
  /** Shows the error on the owner's own local turn. */
  rememberFailedTurn: (error: unknown) => void;
  syncMessages: () => Promise<void>;
  reportWarning: (message: string, error: unknown) => void;
};

/**
 * A refusal of another person's request is final and expected: the server
 * has already ended the request with the generic reply both people see, so
 * the Mac only syncs to show that reply now. It records no turn of its own
 * and never asks again. Any other failure is reported, and the owner's own
 * request shows the error on its turn.
 */
export function handleDirectLeaseFailure(error: unknown, options: DirectLeaseFailureOptions): null {
  if (!options.ownRequest && isAgentUnavailableRefusal(error)) {
    void options.syncMessages().catch(() => undefined);
    return null;
  }
  if (options.ownRequest) options.rememberFailedTurn(error);
  options.reportWarning('Agent execution admission failed', error);
  return null;
}
