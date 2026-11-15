import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorLine } from '@/components/ui/ErrorLine';
import { AppDialog, AppDialogActions, AppDialogTitle, type AppDialogAnchor } from '@/components/ui/dialog';
import { groupDissolveErrorMessage } from '@/features/chat/groupCreateCopy';

type DissolveDialogProps = {
  scope: 'group' | 'channel';
  name: string;
  anchorRect?: AppDialogAnchor | null;
  /** Lifts the dialog above a surface it opens from, such as group Info. */
  backdropClassName?: string;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
};

/** Confirms closing a group or one of its channels: everyone keeps the history, no one can send. */
export function DissolveDialog({ scope, name, anchorRect = null, backdropClassName, onCancel, onConfirm }: DissolveDialogProps) {
  const [isDissolving, setIsDissolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = `dissolve-${scope}-dialog-title`;
  const lineId = `dissolve-${scope}-dialog-line`;
  const cancel = () => {
    if (!isDissolving) onCancel();
  };
  const confirm = async () => {
    if (isDissolving) return;
    setIsDissolving(true);
    setError(null);
    try {
      await onConfirm();
      onCancel();
    } catch (caught) {
      setError(groupDissolveErrorMessage(caught, scope));
      setIsDissolving(false);
    }
  };
  return (
    <AppDialog
      titleId={titleId}
      descriptionId={lineId}
      onDismiss={cancel}
      dismissDisabled={isDissolving}
      busy={isDissolving}
      presentation={anchorRect ? 'popover' : 'modal'}
      anchorRect={anchorRect}
      backdropClassName={backdropClassName}
    >
      <AppDialogTitle id={titleId} className="text-[13px] leading-5">Close {name}?</AppDialogTitle>
      <p id={lineId} className="app-transient-muted mt-2 text-[11px] leading-4">
        Everyone keeps the history. No one can send messages.
      </p>
      {error ? (
        <ErrorLine className="mt-2">{error}</ErrorLine>
      ) : null}
      <AppDialogActions className="mt-3 gap-2">
        <Button variant="quiet" size="sm" className="rounded-[12px] px-3" autoFocus disabled={isDissolving} onClick={cancel}>Cancel</Button>
        <Button
          size="sm"
          className="app-transient-danger-button rounded-[12px] px-3"
          disabled={isDissolving}
          aria-busy={isDissolving}
          onClick={() => { void confirm(); }}
        >
          {isDissolving ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          <span>{isDissolving ? 'Closing…' : scope === 'group' ? 'Close group' : 'Close channel'}</span>
        </Button>
      </AppDialogActions>
    </AppDialog>
  );
}
