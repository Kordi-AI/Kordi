import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Open state for a `<details>` menu that closes on an outside pointer press or Escape.
 * Escape returns focus to the summary so keyboard users stay on the trigger.
 */
export function useDismissibleDetails() {
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);

  const close = useCallback((restoreFocus = false) => {
    detailsRef.current?.removeAttribute('open');
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => summaryRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && detailsRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [close, open]);

  return {
    open,
    close,
    detailsRef,
    summaryRef,
    onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open),
  };
}
