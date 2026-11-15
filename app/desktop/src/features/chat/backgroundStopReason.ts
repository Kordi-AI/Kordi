/**
 * Why a background session's execution was stopped. The native turn, the
 * local transcript and the cloud record carry the same shape.
 */
export type TurnStopReasonKind =
  | 'user'
  | 'agent'
  | 'lease_lapsed'
  | 'signed_out'
  | 'account_changed'
  | 'continued_elsewhere'
  | 'app_quit'
  | 'group_closed'
  | 'access_revoked'
  | 'cloud';

export type TurnStopReason = {
  kind: TurnStopReasonKind;
  /** The account whose Stop ended it (`user`). */
  accountId?: string;
  /** The cloud's name for that account. */
  byDisplayName?: string;
  /** The last update the cloud refused before the lease lapsed. */
  status?: number;
  code?: string;
};

/** An update of a background session that the cloud answered and refused. */
export type SubsessionSyncRefusal = { status: number; code: string };

/** A short label for a refused update, such as "version conflict". */
export function refusalLabel(status?: number | null, code?: string | null): string | null {
  if (code === 'subsession_version_conflict') return 'version conflict';
  if (code === 'subsession_is_terminal') return 'already finished';
  if (status === 401) return 'sign-in expired';
  if (status === 413) return 'update too large';
  if (code && code !== 'unknown') {
    const text = code.replace(/^subsession_/, '').replace(/_/g, ' ');
    return status ? `${status} ${text}` : text;
  }
  return status ? `HTTP ${status}` : null;
}

/** One short line for a stopped session, such as "Stopped by you". */
export function stoppedLabel(reason?: TurnStopReason | null, viewerAccountId?: string | null): string {
  switch (reason?.kind) {
    case undefined: return 'Stopped';
    case 'user':
      if (reason.accountId && reason.accountId === viewerAccountId) return 'Stopped by you';
      return reason.byDisplayName ? `Stopped by ${reason.byDisplayName}` : 'Stopped by the owner';
    case 'agent': return 'Stopped by the agent';
    case 'lease_lapsed': {
      const label = refusalLabel(reason.status, reason.code);
      return label ? `Stopped: the cloud refused updates (${label})` : 'Stopped: the app stopped renewing it';
    }
    case 'signed_out': return 'Stopped: signed out';
    case 'account_changed': return 'Stopped: account changed';
    case 'continued_elsewhere': return 'Stopped: continued in a follow-up';
    case 'app_quit': return 'Stopped: the app quit';
    case 'group_closed': return 'Stopped: the group was closed';
    case 'access_revoked': return 'Stopped: access was revoked';
    default: return 'Stopped from another device';
  }
}

/** The status line of a running session whose updates the cloud refuses. */
export function unsyncedLabel(refusal?: SubsessionSyncRefusal | null): string {
  const label = refusal ? refusalLabel(refusal.status, refusal.code) : null;
  return label ? `Not synced (${label})` : 'Not synced';
}
