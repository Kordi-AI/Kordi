import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';

import type { DesktopArtifactPreview } from '@/kordi-app/types';
import { fetchDesktopChatArtifactPreview } from '@/lib/desktop';
import { fetchDesktopChatArtifactBytes, fetchDesktopChatArtifactThumbnail, openDesktopChatArtifactQuickLook } from '@/lib/desktopArtifactOpen';

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
  const image = await fetchDesktopChatArtifactBytes(input.path, input.baseRoot);
  return { src: `data:${image.mimeType};base64,${image.dataBase64}`, sizeBytes: image.sizeBytes };
}

type FileInput = { isNativeShell: boolean; path: string; attachmentId?: string | null; baseRoot?: string | null };

let pdfOverride: ((input: { path: string }) => Promise<Blob>) | undefined;
let thumbnailOverride: ((input: { path: string }) => Promise<ArtifactQuickLookThumbnail>) | undefined;

/** Lets the login-free visual page serve a sample PDF and Quick Look thumbnails. */
export function setArtifactFileLoadersForPreview(loaders: { pdf?: typeof pdfOverride; thumbnail?: typeof thumbnailOverride }) {
  pdfOverride = loaders.pdf;
  thumbnailOverride = loaders.thumbnail;
}

function blobFromBase64(base64: string, type: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

/** A PDF artifact as a blob for the PDF viewer; the caller makes and revokes its object URL. */
export async function loadArtifactPdf(input: FileInput): Promise<{ blob: Blob; sizeBytes: number }> {
  if (pdfOverride) {
    const blob = await pdfOverride(input);
    return { blob, sizeBytes: blob.size };
  }
  if (!input.isNativeShell) throw new Error('PDF previews are available in the desktop app.');
  const file = await fetchDesktopChatArtifactBytes(input.path, input.baseRoot);
  return { blob: blobFromBase64(file.dataBase64, file.mimeType), sizeBytes: file.sizeBytes };
}

/** A Quick Look thumbnail as a PNG data URL, with the file's size. */
export type ArtifactQuickLookThumbnail = { src: string; sizeBytes: number };

/** Draws a thumbnail of any file Quick Look understands: PDF, Office, Keynote, images, video. */
export async function loadArtifactQuickLookThumbnail(input: FileInput): Promise<ArtifactQuickLookThumbnail> {
  if (thumbnailOverride) return thumbnailOverride(input);
  if (!input.isNativeShell) throw new Error('Thumbnails are available in the desktop app.');
  const thumbnail = await fetchDesktopChatArtifactThumbnail(input.path, input.baseRoot);
  return { src: `data:image/png;base64,${thumbnail.pngBase64}`, sizeBytes: thumbnail.sizeBytes };
}

/** Shows the file in the system Quick Look panel; only the desktop app can. */
export async function quickLookArtifact(input: { path: string; baseRoot?: string | null }) {
  return openDesktopChatArtifactQuickLook(input.path, input.baseRoot);
}
