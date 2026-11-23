import type {
  CloudAccount,
  CloudAuthCapabilities,
  CloudProfileUpdateInput,
} from './authClient';
import { CloudAuthError } from './cloudAuthError';
import { isProductionCloudOrigin } from './cloudApiEnvironment';
import { referenceBackedAvatarMutation } from './avatarAssetClient';
import { browserSessionAccountId } from '@web/auth/browserAppRuntime';

type CloudIdentityRequest = <TResponse>(
  path: string,
  init: RequestInit,
  fallbackMessage: string,
) => Promise<TResponse>;

export class CloudIdentityAuthClient {
  constructor(
    private readonly request: CloudIdentityRequest,
    private readonly baseUrl: string,
  ) {}

  async capabilities(): Promise<CloudAuthCapabilities> {
    try {
      return await this.request<CloudAuthCapabilities>(
        '/v1/cloud/auth/capabilities',
        { method: 'GET' },
        'Could not load available sign-in methods.',
      );
    } catch (caught) {
      // The hosted product API supported both OAuth start routes before it
      // exposed the capabilities endpoint. Keep those deployed versions
      // usable while the start route remains the authoritative config check.
      if (
        caught instanceof CloudAuthError
        && caught.status === 404
        && isProductionCloudOrigin(this.baseUrl)
      ) {
        return { password: true, oauthProviders: ['google', 'github'] };
      }
      throw caught;
    }
  }

  me(token: string): Promise<CloudAccount> {
    return this.request<CloudAccount>(
      '/v1/cloud/auth/me',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load account.',
    );
  }

  async updateProfile(
    token: string,
    input: CloudProfileUpdateInput,
    accountId: string | null = null,
  ): Promise<CloudAccount> {
    const avatarMutation = await referenceBackedAvatarMutation({
      request: this.request,
      token,
      entityType: 'human',
      entityId: accountId,
      mutation: input.avatarMutation,
    });
    const agentAvatarMutation = await referenceBackedAvatarMutation({
      request: this.request,
      token,
      entityType: 'agent',
      entityId: accountId ? `cloud-agent:${accountId}` : null,
      mutation: input.agentAvatarMutation,
    });
    return this.request<CloudAccount>(
      '/v1/cloud/auth/me',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          ...input,
          ...(avatarMutation ? { avatarMutation } : {}),
          ...(agentAvatarMutation ? { agentAvatarMutation } : {}),
        }),
      },
      'Could not update profile.',
    );
  }

  async logout(token: string): Promise<void> {
    await this.request<void>(
      browserSessionAccountId(token) ? '/v1/cloud/auth/web/logout' : '/v1/cloud/auth/logout',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not sign out.',
    );
  }
}
