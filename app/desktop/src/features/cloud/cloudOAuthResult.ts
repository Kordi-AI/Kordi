export type CloudOAuthHashError = {
  code: string | null;
  message: string;
};

/** Reads the error the server attached to an OAuth callback fragment, if any. */
export function parseCloudOAuthHashError(hash: string | null | undefined): CloudOAuthHashError | null {
  const trimmed = hash?.trim() ?? '';
  if (!trimmed.startsWith('#')) return null;
  const params = new URLSearchParams(trimmed.slice(1));
  const message = params.get('kordi_cloud_oauth_error')?.trim();
  if (!message) return null;
  const code = params.get('kordi_cloud_oauth_error_code')?.trim() || null;
  return { code, message };
}
