import { defaultCloudAuthClient, type CloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';

export const SHARE_AVAILABILITY_LABEL = 'Share busy/free with people in my chats';
export const SHARE_AVAILABILITY_CAPTION = "Their agents can ask yours when you're free. Event details stay private.";
export const SHARE_AVAILABILITY_SAVE_ERROR = 'Could not save this setting.';

const ME_PATH = '/v1/cloud/auth/me';

/** Whether people in the owner's chats may ask the owner's agent for busy/free times. */
export type CalendarShareClient = {
  /** `null` when the server does not have the setting. */
  get(): Promise<boolean | null>;
  set(enabled: boolean): Promise<boolean>;
};

type TokenLoader = () => Promise<{ token: string } | null>;

function shareFromAccount(value: unknown): boolean | null {
  const share = (value as { shareCalendarAvailability?: unknown } | null)?.shareCalendarAvailability;
  return typeof share === 'boolean' ? share : null;
}

/** Reads and writes `shareCalendarAvailability` on `GET/PATCH /v1/cloud/auth/me`. */
export function createCalendarShareClient(
  client: Pick<CloudAuthClient, 'request'> = defaultCloudAuthClient(),
  session: TokenLoader = loadSession,
): CalendarShareClient {
  const call = async (init: RequestInit, fallback: string) => {
    const stored = await session();
    if (!stored?.token) throw new Error('Sign in to Kordi first.');
    const headers = { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${stored.token}` };
    return shareFromAccount(await client.request<unknown>(ME_PATH, { ...init, headers }, fallback));
  };
  return {
    get: () => call({ method: 'GET' }, 'Could not load account.'),
    async set(enabled) {
      const saved = await call(
        { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shareCalendarAvailability: enabled }) },
        SHARE_AVAILABILITY_SAVE_ERROR,
      );
      if (saved !== enabled) throw new Error(SHARE_AVAILABILITY_SAVE_ERROR);
      return saved;
    },
  };
}
