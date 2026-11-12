import { useRef } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { SettingsRow } from '@/kordi-app/components/settingsLayout';

// Auth pages use the shared settings row so they read like every other settings page.
export function DetailRow({
  title,
  meta,
  detail,
  trailing,
}: {
  title: ReactNode;
  meta?: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <SettingsRow
      title={title}
      description={meta || detail ? <>{detail}{meta ? <span className="block text-[11px] text-[color:var(--utility-meta-text)]">{meta}</span> : null}</> : undefined}
      control={trailing}
    />
  );
}

/** Muted page notice, for example when the backend has no OMP yet. */
export function AuthPageNotice({ children }: { children: ReactNode }) {
  return <p role="note" data-auth-page-notice="" className="m-0 pb-3 text-[12px] leading-5 text-[color:var(--utility-muted-text)]">{children}</p>;
}

function stopEventPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export const nonDragStyle: CSSProperties = { WebkitAppRegion: 'no-drag' as const };

export const authButtonNeutralClass = 'app-control-chip border';

export const authButtonPrimaryClass = 'app-button-primary';

export const authButtonDangerClass = 'app-transient-row-danger border';

export const authActiveBadgeClass =
  'inline-flex h-7 items-center justify-center rounded-full border border-[color:var(--app-control-border)] bg-[color:var(--app-control-active)] px-2.5 text-[11px] font-medium text-[color:var(--utility-foreground)]';

const authButtonBaseClass =
  'inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-[12px] font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 cursor-pointer';

type AuthActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function AuthActionButton({
  className,
  style,
  onClick,
  onMouseDown,
  onMouseUp,
  onPointerDown,
  onPointerUp,
  type = 'button',
  ...props
}: AuthActionButtonProps) {
  const lastPressAtRef = useRef(0);

  const triggerPress = (
    event: ReactMouseEvent<HTMLButtonElement> | ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (props.disabled) return;
    const now = Date.now();
    if (now - lastPressAtRef.current < 250) return;
    lastPressAtRef.current = now;
    onClick?.(event as unknown as ReactMouseEvent<HTMLButtonElement>);
  };

  return (
    <button
      {...props}
      type={type}
      onClick={(event) => {
        stopEventPropagation(event);
        triggerPress(event);
      }}
      className={cn(authButtonBaseClass, className)}
      style={{ ...nonDragStyle, ...style }}
      onMouseDown={(event) => {
        stopEventPropagation(event);
        onMouseDown?.(event);
      }}
      onMouseUp={(event) => {
        stopEventPropagation(event);
        onMouseUp?.(event);
        triggerPress(event);
      }}
      onPointerDown={(event) => {
        stopEventPropagation(event);
        onPointerDown?.(event);
      }}
      onPointerUp={(event) => {
        stopEventPropagation(event);
        onPointerUp?.(event);
        triggerPress(event);
      }}
    />
  );
}
