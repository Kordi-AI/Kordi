import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';

import type { SessionTraceExportContext } from '@/features/sessionExport/exportSessionTrace';
import type { SessionActionTarget } from '@/pages/SessionActionOverlays';

type UseKordiSessionTraceExportArgs = SessionTraceExportContext & {
  setDesktopError: Dispatch<SetStateAction<string | null>>;
};

/**
 * Collects a session's complete trace and saves it as one JSON Lines file.
 * The collector and serializer load on the first export.
 */
export function useKordiSessionTraceExport({
  account,
  canonicalState,
  conversations,
  contacts,
  desktopState,
  isNativeShell,
  setDesktopError,
}: UseKordiSessionTraceExportArgs) {
  const exporting = useRef(false);
  return useCallback(async (target: SessionActionTarget) => {
    if ((!isNativeShell && !isBrowserAppRuntime()) || !target.sessionId.trim() || exporting.current) return;
    exporting.current = true;
    setDesktopError(null);
    try {
      const { exportSessionTrace } = await import('@/features/sessionExport/exportSessionTrace');
      await exportSessionTrace(target, { account, canonicalState, conversations, contacts, desktopState, isNativeShell });
    } catch (error) {
      const reason = error instanceof Error ? error.message.trim() : '';
      setDesktopError(reason ? `Export failed: ${reason}` : 'Export failed');
    } finally {
      exporting.current = false;
    }
  }, [account, canonicalState, contacts, conversations, desktopState, isNativeShell, setDesktopError]);
}
