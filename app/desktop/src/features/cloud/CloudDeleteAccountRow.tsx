import { lazy, Suspense, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SettingsRow } from '@/kordi-app/components';

// Loaded on first use so the deletion flow stays out of the main bundle.
const CloudDeleteAccountDialog = lazy(() => import('./CloudDeleteAccountDialog'));

/** Profile › Session › Delete account, on the Mac and in the browser. */
export function CloudDeleteAccountRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsRow
        title="Delete account"
        description="Delete your account and all of its data."
        className="app-cloud-account-settings-meta-row"
        control={(
          <Button
            type="button"
            variant="secondary"
            className="h-8 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3.5 text-[12px] text-rose-200 hover:bg-rose-500/15 hover:text-rose-100"
            onClick={() => setOpen(true)}
          >
            Delete
          </Button>
        )}
      />
      {open ? (
        <Suspense fallback={null}>
          <CloudDeleteAccountDialog onDismiss={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
