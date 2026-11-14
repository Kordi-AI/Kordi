import { ErrorLine } from '@/components/ui/errors';
import { reminderPermissionNotice, type ReminderPermission } from './reminderPermission';

export function ReminderPermissionLine({ state, busy, onAllow, onOpenSettings }: { state: ReminderPermission; busy: boolean; onAllow: () => void; onOpenSettings: () => void }) {
  const notice = reminderPermissionNotice(state);
  if (!notice) return null;
  const action = notice.action === 'allow'
    ? { label: 'Allow', onClick: onAllow, disabled: busy }
    : { label: 'Open System Settings', onClick: onOpenSettings };
  return <ErrorLine role="status" action={action}>Notifications are off.</ErrorLine>;
}
