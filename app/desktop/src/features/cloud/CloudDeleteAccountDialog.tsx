import { useEffect, useId, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { ErrorLine } from '@/components/ui/ErrorLine';
import { CloudSignupVerificationFields } from '@/kordi-app/cloud/CloudSignupVerificationFields';
import { useCloudSignupVerification } from '@/kordi-app/cloud/useCloudSignupVerification';

import {
  ACCOUNT_DELETION_SIGN_IN_AGAIN,
  ACCOUNT_DELETION_SUMMARY,
  accountDeletionErrorMessage,
  accountDeletionProofMode,
  accountDeletionProofModeAfter,
  type AccountDeletionProofMode,
} from './accountDeletionProof';
import {
  createAccountSecurityClient,
  type AccountDeletionProof,
  type AccountSecurityClient,
  type AccountSecurityOverview,
  type DeletedAccountSession,
} from './accountSecurityClient';
import { endDeletedCloudSession } from './cloudAccountDeletion';
import { CloudAuthError } from './cloudAuthError';

type ProofStep = AccountDeletionProofMode | 'loading' | 'unavailable';

export type CloudDeleteAccountDialogProps = {
  onDismiss: () => void;
  client?: AccountSecurityClient;
  /** Ends this device's session once the account is deleted. */
  onDeleted?: (session: DeletedAccountSession) => Promise<unknown>;
};

const CODE_PATTERN = /^\d{6}$/;
const INPUT_CLASS = 'app-input-shell h-10 w-full rounded-[12px] px-3 text-[13px] text-[color:var(--app-transient-text)] outline-none';
const LABEL_CLASS = 'text-[12px] font-medium text-[color:var(--app-transient-muted-text)]';
const DESTRUCTIVE_CLASS = 'rounded-full bg-rose-500 px-4 text-white hover:bg-rose-400';

/** Profile › Delete account: the proof the server needs, then a final confirmation. */
export default function CloudDeleteAccountDialog({
  onDismiss,
  client,
  onDeleted = endDeletedCloudSession,
}: CloudDeleteAccountDialogProps) {
  const [security] = useState(() => client ?? createAccountSecurityClient());
  const [overview, setOverview] = useState<AccountSecurityOverview | null>(null);
  const [step, setStep] = useState<ProofStep>('loading');
  const [loads, setLoads] = useState(0);
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'code' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const email = overview?.email.address ?? '';
  const {
    challenge, verificationCode, setVerificationCode, resendSeconds, sendCode, resetVerification,
  } = useCloudSignupVerification(email, () => security.requestCode());

  useEffect(() => {
    let current = true;
    security.overview().then(
      (next) => {
        if (!current) return;
        setOverview(next);
        setStep(accountDeletionProofMode(next));
      },
      () => { if (current) setStep('unavailable'); },
    );
    return () => { current = false; };
  }, [loads, security]);

  const reloadOverview = () => {
    setStep('loading');
    setLoads((value) => value + 1);
  };

  const proof: AccountDeletionProof | null = step === 'password'
    ? (password ? { currentPassword: password } : null)
    : step === 'email-code'
      ? (challenge && CODE_PATTERN.test(verificationCode)
        ? { verificationId: challenge.verificationId, verificationCode }
        : null)
      : step === 'recent-sign-in' ? {} : null;

  const refused = (caught: unknown, fallback: string) => {
    if (caught instanceof CloudAuthError && caught.code === 'account_changed') {
      // The password or email changed meanwhile: ask again for the proof it needs now.
      resetVerification();
      reloadOverview();
    } else if (step !== 'loading' && step !== 'unavailable') {
      const next = accountDeletionProofModeAfter(caught, step, Boolean(email));
      if (next !== step) {
        setStep(next);
        resetVerification();
      }
    }
    setError(accountDeletionErrorMessage(caught, fallback));
  };

  const requestCode = async () => {
    if (busy) return;
    setBusy('code');
    setError(null);
    try {
      await sendCode();
    } catch (caught) {
      refused(caught, 'Could not send a code. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const review = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!proof || busy) return;
    setError(null);
    setConfirming(true);
  };

  const confirmDeletion = async () => {
    if (!proof || busy) return;
    setBusy('delete');
    setError(null);
    let session: DeletedAccountSession;
    try {
      session = await security.deleteAccount(proof);
    } catch (caught) {
      setConfirming(false);
      setBusy(null);
      refused(caught, 'Could not delete your account. Try again.');
      return;
    }
    // The account is gone: this device signs out and erases its data.
    await onDeleted(session).catch(() => undefined);
  };

  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const deleting = busy === 'delete';

  const proofStep = (() => {
    switch (step) {
      case 'loading':
        return <p role="status" className={LABEL_CLASS}>Loading…</p>;
      case 'unavailable':
        return (
          <ErrorLine className="mt-0" action={{ label: 'Try again', onClick: reloadOverview }}>
            Could not load your account.
          </ErrorLine>
        );
      case 'recent-sign-in':
        return null;
      case 'sign-in-again':
        return <p className={LABEL_CLASS}>{ACCOUNT_DELETION_SIGN_IN_AGAIN}</p>;
      case 'password':
        return (
          <>
            <p className={LABEL_CLASS}>Confirm it&apos;s you</p>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
              aria-label="Current password"
              value={password}
              disabled={busy !== null}
              onChange={(event) => {
                setPassword(event.currentTarget.value);
                if (error) setError(null);
              }}
              className={INPUT_CLASS}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </>
        );
      case 'email-code':
        if (!challenge) {
          return (
            <>
              <p className={LABEL_CLASS}>Confirm it&apos;s you</p>
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  className="h-8 rounded-lg px-3.5 text-[12px]"
                  disabled={busy !== null || resendSeconds > 0}
                  onClick={() => { void requestCode(); }}
                >
                  {busy === 'code' ? 'Sending code…' : resendSeconds > 0 ? `Email me a code (${resendSeconds}s)` : 'Email me a code'}
                </Button>
              </div>
            </>
          );
        }
        return (
          <CloudSignupVerificationFields
            email={email}
            busy={busy !== null}
            resendSeconds={resendSeconds}
            onResend={() => { void requestCode(); }}
          >
            <input
              aria-label="Email code"
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              value={verificationCode}
              disabled={busy !== null}
              onChange={(event) => {
                setVerificationCode(event.currentTarget.value.replace(/\D/g, '').slice(0, 6));
                if (error) setError(null);
              }}
              className={INPUT_CLASS}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </CloudSignupVerificationFields>
        );
    }
  })();

  return (
    <AppDialog
      titleId={titleId}
      descriptionId={descriptionId}
      onDismiss={confirming ? () => setConfirming(false) : onDismiss}
      dismissDisabled={busy !== null}
      busy={busy !== null}
      className="max-w-md rounded-[20px]"
      backdropClassName="!z-[100000]"
    >
      {confirming ? (
        <>
          <AppDialogTitle id={titleId}>Delete account?</AppDialogTitle>
          <AppDialogDescription id={descriptionId}>This can&apos;t be undone.</AppDialogDescription>
          <AppDialogActions>
            <Button variant="quiet" className="rounded-full px-4" autoFocus disabled={deleting} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button className={DESTRUCTIVE_CLASS} disabled={deleting} onClick={() => { void confirmDeletion(); }}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </AppDialogActions>
        </>
      ) : (
        <form onSubmit={review}>
          <AppDialogTitle id={titleId}>Delete account</AppDialogTitle>
          <AppDialogDescription id={descriptionId}>{ACCOUNT_DELETION_SUMMARY}</AppDialogDescription>
          {proofStep ? <div className="mt-4 grid gap-2">{proofStep}</div> : null}
          {error ? <ErrorLine id={errorId} className="mt-3">{error}</ErrorLine> : null}
          <AppDialogActions>
            <Button type="button" variant="quiet" className="rounded-full px-4" autoFocus disabled={busy !== null} onClick={onDismiss}>
              Cancel
            </Button>
            <Button type="submit" className={DESTRUCTIVE_CLASS} disabled={!proof || busy !== null}>
              Delete account
            </Button>
          </AppDialogActions>
        </form>
      )}
    </AppDialog>
  );
}
