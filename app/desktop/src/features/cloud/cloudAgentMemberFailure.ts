import { cloudAgentFailureCodeValue } from './cloudAgentFailureCode';

/**
 * What a chat member who does not own the agent reads when its reply failed.
 * The line is chosen from the failure code alone, never from stored or
 * provider text, so the owner's account details never reach other members.
 * Mac, web and iPhone use the same words. The codes mirror the table in
 * `bridges/cloud-server/src/cloud_agent_runtime/runs/envelopes/failure_code.rs`.
 */
export type CloudAgentMemberFailureReason = 'no_model' | 'reconnect' | 'choose_model' | 'model_service';

const UNKNOWN_OWNER = 'The owner';

/** The short reason a member reads for a failure code, or null for the neutral line. */
export function cloudAgentMemberFailureReason(code: unknown): CloudAgentMemberFailureReason | null {
  switch (cloudAgentFailureCodeValue(code)) {
    case 'missing_provider_auth':
      return 'no_model';
    case 'provider_auth_rejected':
    case 'hosted_credentials_unavailable':
    case 'provider_sign_in_failed':
      return 'reconnect';
    case 'model_unavailable':
      return 'choose_model';
    case 'model_provider_error':
    case 'provider_call_failed':
      return 'model_service';
    default:
      return null;
  }
}

/** The neutral line: the agent could not reply. */
export function cloudAgentCouldNotReplyText(agentName: string | null | undefined): string {
  const name = agentName?.trim();
  return name ? `${name} couldn't reply.` : "The agent couldn't reply.";
}

/** The owner's first name, or "The owner" when the name is unknown or only says "You". */
function ownerFirstName(ownerName: string | null | undefined): string {
  const name = ownerName?.trim() ?? '';
  if (!name || name.toLowerCase() === 'you') return UNKNOWN_OWNER;
  return name.split(/\s+/)[0] || UNKNOWN_OWNER;
}

/** The failure line a member who does not own the agent reads. */
export function cloudAgentMemberFailureText(input: {
  failureCode: unknown;
  ownerName: string | null | undefined;
  agentName: string | null | undefined;
}): string {
  switch (cloudAgentMemberFailureReason(input.failureCode)) {
    case 'no_model':
      return `${ownerFirstName(input.ownerName)} hasn't connected a model yet.`;
    case 'reconnect':
      return `${ownerFirstName(input.ownerName)} needs to reconnect their model.`;
    case 'choose_model':
      return `${ownerFirstName(input.ownerName)} needs to choose another model.`;
    case 'model_service':
      return "The model service didn't respond. Try again.";
    default:
      return cloudAgentCouldNotReplyText(input.agentName);
  }
}
