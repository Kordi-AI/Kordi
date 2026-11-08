import type { CloudGroupAgentRuntime } from './cloudGroupControlContext';

type Retry = (runtime: CloudGroupAgentRuntime) => void;

/** Most mentions kept at once; the oldest goes first, since the server's hold ends for it first. */
export const MAX_DEFERRED_MENTIONS = 50;

/**
 * Mentions of this Mac's agent that arrived while its runtime was not ready,
 * for example while it reloaded after the owner picked another model. The
 * server holds such a request for an online Mac, so applying it again once
 * the runtime is ready lets this Mac claim it within that hold. Each mention
 * is kept once and applied again at most once.
 */
export class CloudGroupDeferredMentions {
  private readonly retries = new Map<string, Retry>();

  defer(requestId: string, retry: Retry): void {
    if (!requestId.trim()) return;
    this.retries.delete(requestId);
    this.retries.set(requestId, retry);
    while (this.retries.size > MAX_DEFERRED_MENTIONS) {
      const oldest = this.retries.keys().next().value;
      if (oldest === undefined) break;
      this.retries.delete(oldest);
    }
  }

  /** Applies every kept mention again with a ready runtime. */
  applyAll(runtime: CloudGroupAgentRuntime): void {
    if (runtime.ready === false || this.retries.size === 0) return;
    const retries = [...this.retries.values()];
    this.retries.clear();
    for (const retry of retries) retry(runtime);
  }

  clear(): void {
    this.retries.clear();
  }
}
