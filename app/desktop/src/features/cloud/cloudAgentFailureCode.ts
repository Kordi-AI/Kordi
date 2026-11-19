/**
 * Stable categories a failed agent reply carries. Every member receives the
 * reply, so its text is only a neutral line; each viewer renders its own line
 * from the code. Other members read a short fixed reason chosen from the code
 * (`cloudAgentMemberFailure.ts`); the agent's owner reads the detailed reason.
 * `provider_sign_in_failed` and `provider_call_failed` come from the owner's
 * Mac, whose row keeps the detailed line for the owner.
 */
export const CLOUD_AGENT_FAILURE_CODES = [
  'provider_auth_rejected',
  'missing_provider_auth',
  'hosted_credentials_unavailable',
  'model_unavailable',
  'model_provider_error',
  'provider_sign_in_failed',
  'provider_call_failed',
  'sandbox_error',
  'failed',
] as const;

export type CloudAgentFailureCode = (typeof CLOUD_AGENT_FAILURE_CODES)[number];

/** A known failure code, or null for a missing or unknown value. */
export function cloudAgentFailureCodeValue(value: unknown): CloudAgentFailureCode | null {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (CLOUD_AGENT_FAILURE_CODES as readonly string[]).includes(code)
    ? code as CloudAgentFailureCode
    : null;
}

/** The `failureCode` field a wire payload or stored row carries, when it has one. */
export function cloudAgentFailureCodeField(value: unknown): { failureCode?: CloudAgentFailureCode } {
  const failureCode = cloudAgentFailureCodeValue(value);
  return failureCode ? { failureCode } : {};
}
