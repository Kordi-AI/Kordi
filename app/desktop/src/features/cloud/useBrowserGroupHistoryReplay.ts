import { useCallback } from 'react';
import type { ApplyBrowserGroupHistoryPage } from './useBrowserGroupHistory';
import type { BrowserGroupHistoryApply } from '@web/runtime/browserGroupHistoryReplay';
import type { CanonicalSessionStateSetter } from './cloudGroupControlContext';

export function useBrowserGroupHistoryReplay(
  apply: BrowserGroupHistoryApply,
  publish: CanonicalSessionStateSetter,
  flush: () => void,
): ApplyBrowserGroupHistoryPage {
  return useCallback(async (rows, session, isCurrent, conversation) => {
    if (import.meta.env?.VITE_KORDI_WEB_APP !== '1') return [];
    const { replayBrowserGroupHistory } = await import('@web/runtime/browserGroupHistoryReplay');
    const result = await replayBrowserGroupHistory(rows, session, isCurrent, conversation, apply);
    if (!isCurrent() || !result) return [];
    if (result.updates.length) {
      publish(current => result.updates.reduce((state, update) => update(state), current));
      flush();
    }
    return result.messages;
  }, [apply, flush, publish]);
}
