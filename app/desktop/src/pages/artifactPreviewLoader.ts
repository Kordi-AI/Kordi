import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';

import type { DesktopArtifactPreview } from '@/kordi-app/types';
import { fetchDesktopChatArtifactPreview } from '@/lib/desktop';

type ArtifactPreviewInput = {
  isNativeShell: boolean; path: string; attachmentId?: string | null; baseRoot?: string | null;
};

let previewOverride: ((input: ArtifactPreviewInput) => Promise<DesktopArtifactPreview>) | undefined;

/** Lets the login-free visual page serve sample file contents, so every file type can be reviewed. */
export function setArtifactPreviewLoaderForPreview(loader: typeof previewOverride) {
  previewOverride = loader;
}

/** Whether the visual page supplies sample files. */
export function hasArtifactPreviewLoaderForPreview() {
  return Boolean(previewOverride);
}

/** Whether file contents can be read here: the desktop app, the browser app, or the visual page. */
export function artifactPreviewsAvailable(isNativeShell: boolean) {
  return Boolean(previewOverride) || isNativeShell || isBrowserAppRuntime();
}

export async function loadArtifactPreview(input: ArtifactPreviewInput) {
  if (previewOverride) return previewOverride(input);
  if (input.isNativeShell) return fetchDesktopChatArtifactPreview(input.path, input.baseRoot);
  if (import.meta.env?.VITE_KORDI_WEB_APP === '1') {
    const { fetchBrowserArtifactPreview } = await import('@web/runtime/browserArtifactPreview');
    return fetchBrowserArtifactPreview(input.path, input.attachmentId);
  }
  throw new Error('Artifact previews are available in the desktop app.');
}
