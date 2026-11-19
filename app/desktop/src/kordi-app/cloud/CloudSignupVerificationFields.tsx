import type { ReactNode } from 'react';

/**
 * The emailed-code and password field of the account settings and the dialogs
 * opened from them, such as Delete account. Add `app-flat-input-error` while
 * the field's error is shown.
 */
export const CLOUD_ACCOUNT_FIELD_CLASS = 'app-input-shell app-flat-input h-10 w-full min-w-0 rounded-[10px] px-3 text-[13px] font-normal text-white outline-none';

export function CloudSignupVerificationFields({
  email, busy, resendSeconds, onResend, onChangeEmail, changeEmailLabel = 'Change email', children,
}: {
  email: string;
  busy: boolean;
  resendSeconds: number;
  onResend: () => void;
  /** Omitted where the address cannot change, such as confirming a deletion. */
  onChangeEmail?: () => void;
  changeEmailLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 text-[12px] font-medium tracking-[-0.005em]">
      <p role="status" className="text-muted-foreground">
        Enter the 6-digit code sent to {email}. It expires in 10 minutes. Check your spam folder too.
      </p>
      {children}
      <div className="flex justify-between">
        <button type="button" disabled={busy || resendSeconds > 0} onClick={onResend}>
          {resendSeconds > 0 ? `Resend in ${resendSeconds}s` : 'Resend code'}
        </button>
        {onChangeEmail ? <button type="button" disabled={busy} onClick={onChangeEmail}>{changeEmailLabel}</button> : null}
      </div>
    </div>
  );
}
