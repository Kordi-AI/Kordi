import { useState, useSyncExternalStore } from 'react';

import { Avatar } from '@/components/ui/avatar';
import {
  AGENT_CANONICAL_AVATAR_STYLE,
  HUMAN_CANONICAL_AVATAR_STYLE,
  canonicalAvatarImageUrl,
  generatedAvatarPreviewUrl,
} from '@/features/cloud/canonicalAvatar';
import { cloudDefaultAgentAvatarSeed } from '@/features/canonical/avatarIdentity';
import { isDeletedAccountAvatarSeed, KORDI_DELETED_ACCOUNT_NAME } from '@/features/systemAgent/systemAgentIdentity';
import {
  DEFAULT_LOCAL_AGENT_AVATAR_SEED,
  getLocalAgentAvatar,
  isLocalAgentAvatarSeed,
  subscribeLocalAgentAvatar,
} from '@/features/canonical/localAgentAvatar';
import { cn } from '@/lib/utils';
import { useAvatarOverride } from './avatarOverrides';
import { useLocalAgentAvatar } from './useLocalAgentAvatar';
import {
  resolveIdentityAvatarPresentation,
  useActiveLocalProfileIdentity,
} from './localProfileIdentity';
import { shouldLoadAvatarThroughNativeProxy, useRemoteAvatarImage } from './remoteAvatarImage';

export type IdentityAvatarKind = 'human' | 'agent';

export type IdentityAvatarProps = {
  kind: IdentityAvatarKind;
  seed: string;
  /** Resolve the visual identity from the signed-in profile, even when the UI label is "Me" or "You". */
  isSelf?: boolean;
  name?: string | null;
  imageUrl?: string | null;
  avatarKey?: string | null;
  className?: string;
  cornerRadius?: string;
  generatedClassName?: string;
  /** Accessible status description; visible status belongs in the surrounding text. */
  presenceStatus?: 'online' | 'offline' | string | null;
  presenceLabel?: string | null;
};

const LOCAL_PROFILE_AVATAR_SEED_KEY = 'kordi.localProfileAvatarSeed.v1';
const LOCAL_PROFILE_IDENTITY_SEED_KEY = 'kordi.localProfileIdentitySeed.v1';
const LOCAL_AVATAR_SEEDS_CHANGE_EVENT = 'kordi-local-avatar-seeds-change';

let localProfileAvatarSeedSnapshot: string | null = null;

function browserAvatarScope() {
  if (typeof window === 'undefined') return 'desktop';
  return window.location.origin || 'desktop';
}

function readLocalStorageValue(key: string) {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key)?.trim() || null;
  } catch {
    return null;
  }
}

function writeLocalStorageValue(key: string, value?: string | null) {
  if (typeof window === 'undefined') return;
  const normalized = value?.trim();
  if (!normalized) return;
  try {
    window.localStorage.setItem(key, normalized);
  } catch {
    // Ignore storage failures; deterministic fallbacks keep generated avatars stable.
  }
}

function emitLocalAvatarSeedsChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new window.Event(LOCAL_AVATAR_SEEDS_CHANGE_EVENT));
}

function subscribeLocalAvatarSeeds(onStoreChange: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(LOCAL_AVATAR_SEEDS_CHANGE_EVENT, onStoreChange);
  window.addEventListener('storage', onStoreChange);
  return () => {
    window.removeEventListener(LOCAL_AVATAR_SEEDS_CHANGE_EVENT, onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

export function getLocalProfileAvatarSeed() {
  if (localProfileAvatarSeedSnapshot?.trim()) return localProfileAvatarSeedSnapshot;

  const identitySeed = readLocalStorageValue(LOCAL_PROFILE_IDENTITY_SEED_KEY);
  if (identitySeed) return identitySeed;

  const legacySeed = readLocalStorageValue(LOCAL_PROFILE_AVATAR_SEED_KEY);
  if (legacySeed) return `local-human-profile:${browserAvatarScope()}:${legacySeed}`;

  return `local-human-profile:${browserAvatarScope()}`;
}

export function setLocalProfileAvatarSeed(seed?: string | null) {
  const normalized = seed?.trim();
  if (!normalized || normalized === localProfileAvatarSeedSnapshot) return;
  localProfileAvatarSeedSnapshot = normalized;
  writeLocalStorageValue(LOCAL_PROFILE_IDENTITY_SEED_KEY, normalized);
  emitLocalAvatarSeedsChange();
}

export function useLocalProfileAvatarSeed() {
  return useSyncExternalStore(
    subscribeLocalAvatarSeeds,
    getLocalProfileAvatarSeed,
    () => 'local-human-profile',
  );
}

export function getLocalAgentAvatarSeed() {
  return getLocalAgentAvatar().seed;
}

export function useLocalAgentAvatarSeed() {
  return useSyncExternalStore(
    subscribeLocalAgentAvatar,
    getLocalAgentAvatarSeed,
    () => DEFAULT_LOCAL_AGENT_AVATAR_SEED,
  );
}

export function getIdentityAvatarKey(kind: IdentityAvatarKind, seed: string, avatarKey?: string | null) {
  const value = avatarKey?.trim() || seed.trim() || 'unknown';
  return kind === 'agent' ? `agent:${value.replace(/^agent:/i, '')}` : avatarKey?.trim() || `human:${value}`;
}

export function IdentityAvatar({ kind, seed, isSelf = false, name, imageUrl, avatarKey, className, cornerRadius = '17%', generatedClassName, presenceStatus, presenceLabel }: IdentityAvatarProps) {
  const activeLocalProfileIdentity = useActiveLocalProfileIdentity();
  const localAgentAvatar = useLocalAgentAvatar();
  // The stand-in for a deleted account is no person: it is drawn as the flat neutral placeholder
  // with nothing inside, never as a generated or uploaded picture that could match someone's, and
  // nothing is fetched for it. Its accessible name is "Deleted account".
  const standIn = !isSelf && isDeletedAccountAvatarSeed(seed);
  // An account's default agent id draws that agent's server default avatar; local overrides stay keyed by the given seed.
  const defaultAgentSeed = kind === 'agent' ? cloudDefaultAgentAvatarSeed(seed) : null;
  // Every seed that names the user's own agent renders the account's agent avatar.
  const isOwnAgent = kind === 'agent' && !isSelf && !standIn && isLocalAgentAvatarSeed(defaultAgentSeed ?? seed, localAgentAvatar);
  const { fallbackLabel, normalizedSeed, resolvedImageUrl: identityImageUrl } = resolveIdentityAvatarPresentation({
    kind,
    seed: isOwnAgent ? localAgentAvatar.seed : seed,
    isSelf,
    name,
    imageUrl,
    activeLocalProfileIdentity,
  });
  const resolvedAvatarKey = getIdentityAvatarKey(kind, normalizedSeed, isSelf ? null : avatarKey);
  const localOverride = useAvatarOverride(resolvedAvatarKey);
  const ownAgentImageUrl = isOwnAgent ? localAgentAvatar.imageUrl : null;
  const generatedImageUrl = !standIn && !identityImageUrl && !localOverride && !ownAgentImageUrl
    ? generatedAvatarPreviewUrl(
        kind === 'agent'
          ? AGENT_CANONICAL_AVATAR_STYLE
          : HUMAN_CANONICAL_AVATAR_STYLE,
        isOwnAgent ? normalizedSeed : defaultAgentSeed ?? normalizedSeed,
      )
    : null;
  // The account snapshot is the source of truth for the user's own agent; row props can be stale.
  const originalImageUrl = standIn ? null : canonicalAvatarImageUrl(isOwnAgent
    ? ownAgentImageUrl || identityImageUrl || localOverride
    : identityImageUrl || localOverride || ownAgentImageUrl)
    || generatedImageUrl;
  const needsNativeProxy = shouldLoadAvatarThroughNativeProxy(originalImageUrl);
  const remoteAvatar = useRemoteAvatarImage(originalImageUrl, needsNativeProxy);
  const resolvedImageUrl = needsNativeProxy
    ? (remoteAvatar.status === 'ready' ? remoteAvatar.dataUrl : null)
    : originalImageUrl;
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const displayImageUrl = resolvedImageUrl && failedImageUrl !== resolvedImageUrl ? resolvedImageUrl : null;
  const [lastReadyAvatar, setLastReadyAvatar] = useState<{
    identityKey: string;
    imageUrl: string;
  } | null>(null);
  const isRemoteImagePending = needsNativeProxy
    && (remoteAvatar.status === 'idle' || remoteAvatar.status === 'pending');
  const retainedImageUrl = !displayImageUrl
    && needsNativeProxy
    && (isRemoteImagePending || remoteAvatar.status === 'failed')
    && lastReadyAvatar?.identityKey === resolvedAvatarKey
    ? lastReadyAvatar.imageUrl
    : null;
  const visibleImageUrl = displayImageUrl || retainedImageUrl;
  const avatarState = standIn
    ? 'placeholder'
    : displayImageUrl
    ? 'ready'
    : retainedImageUrl
      ? 'stale'
    : isRemoteImagePending
      ? 'pending'
      : needsNativeProxy && remoteAvatar.status === 'failed'
        ? 'failed'
        : 'fallback';
  const label = standIn
    ? KORDI_DELETED_ACCOUNT_NAME
    : name?.trim() ? `${name} avatar` : `${kind === 'agent' ? 'Agent' : 'Human'} avatar`;

  const normalizedPresenceStatus = presenceStatus?.trim().toLowerCase() === 'online' ? 'online' : presenceStatus ? 'offline' : null;
  const resolvedPresenceLabel = presenceLabel?.trim()
    || (normalizedPresenceStatus ? `${name?.trim() || fallbackLabel} is ${normalizedPresenceStatus}` : null);

  return (
    <span className={cn('relative inline-flex shrink-0 rounded-[17%]', className)} style={{ borderRadius: cornerRadius }} data-identity-avatar="">
      <Avatar
        className="h-full w-full rounded-[17%] bg-transparent"
        style={{ borderRadius: cornerRadius }}
        role={standIn ? 'img' : undefined}
        aria-label={label}
        aria-description={resolvedPresenceLabel ?? undefined}
        data-avatar-kind={kind}
        data-avatar-state={avatarState}
      >
        {standIn ? (
          <span className="block h-full w-full bg-slate-200 dark:bg-slate-700" aria-hidden="true" />
        ) : visibleImageUrl ? null : isRemoteImagePending ? (
          <span
            className="block h-full w-full bg-slate-300/55 dark:bg-slate-700/55"
            aria-hidden="true"
          />
        ) : (
          <span className={cn('block h-full w-full bg-slate-200 dark:bg-slate-700', generatedClassName)} aria-hidden="true" />
        )}
        {visibleImageUrl ? (
          <img
            src={visibleImageUrl}
            alt=""
            className="absolute inset-0 block h-full w-full object-cover"
            draggable={false}
            onLoad={() => {
              setLastReadyAvatar((current) => (
                current?.identityKey === resolvedAvatarKey && current.imageUrl === visibleImageUrl
                  ? current
                  : { identityKey: resolvedAvatarKey, imageUrl: visibleImageUrl }
              ));
            }}
            onError={() => {
              setFailedImageUrl(visibleImageUrl);
            }}
          />
        ) : null}
      </Avatar>
    </span>
  );
}
