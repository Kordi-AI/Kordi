import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';

import type { DesktopArtifactPreview } from '@/kordi-app/types';
import { fetchDesktopChatArtifactPreview } from '@/lib/desktop';
import { fetchDesktopChatArtifactImage } from '@/lib/desktopArtifactOpen';

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

/** An image artifact ready to draw: a data or object URL, with its byte size when known. */
export type ArtifactImage = { src: string; sizeBytes: number | null };

let imageOverride: ((input: { path: string; attachmentId?: string | null }) => Promise<ArtifactImage>) | undefined;

/** Lets the login-free visual page serve sample images. */
export function setArtifactImageLoaderForPreview(loader: typeof imageOverride) {
  imageOverride = loader;
}

/** Reads an image artifact from this Mac for the image viewer and card thumbnails. */
export async function loadArtifactImage(input: { isNativeShell: boolean; path: string; attachmentId?: string | null; baseRoot?: string | null }): Promise<ArtifactImage> {
  if (imageOverride) return imageOverride(input);
  if (!input.isNativeShell) throw new Error('Images are available in the desktop app.');
  const image = await fetchDesktopChatArtifactImage(input.path, input.baseRoot);
  return { src: `data:${image.mimeType};base64,${image.dataBase64}`, sizeBytes: image.sizeBytes };
}
