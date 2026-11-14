import { markNotificationRequestStalled, notificationRequestStalled } from '@/features/notifications/notificationRequestStall';

export const NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';

/** What `desktop_digest_reminders` reports, plus the page's own states before and after a read. */
export type ReminderPermission = 'unknown' | 'granted' | 'default' | 'denied' | 'unavailable' | 'error';

export type ReminderPermissionNotice = { action: 'allow' | 'settings' };

export function reminderPermissionFrom(value: string): ReminderPermission {
  return value === 'granted' || value === 'default' || value === 'denied' || value === 'unavailable' ? value : 'error';
}

/** Records the result of a person's request and returns the state to show. */
export function afterReminderRequest(value: string): ReminderPermission {
  const state = reminderPermissionFrom(value);
  if (state === 'default') markNotificationRequestStalled();
  return state;
}

export function reminderPermissionNotice(state: ReminderPermission): ReminderPermissionNotice | null {
  if (state === 'default') return { action: notificationRequestStalled() ? 'settings' : 'allow' };
  if (state === 'denied') return { action: 'settings' };
  return null;
}
