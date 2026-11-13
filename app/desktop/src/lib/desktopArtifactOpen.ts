import { invokeDesktop } from './desktop';

/** Opens an artifact file in its default app; the path resolves like a preview. */
export async function openDesktopChatArtifact(path: string, baseRoot?: string | null) {
  return invokeDesktop<string>('desktop_chat_artifact_open', { path, baseRoot });
}

/** Opens a fresh copy of a shared document's text, under `name`, in its default app. */
export async function openDesktopChatArtifactCopy(name: string, contents: string) {
  return invokeDesktop<string>('desktop_chat_artifact_open_copy', { name, contents });
}

export type DesktopArtifactBytes = { path: string; mimeType: string; sizeBytes: number; dataBase64: string };

/** Reads an image or PDF artifact for its viewer and card thumbnails; the path resolves like a preview. */
export async function fetchDesktopChatArtifactBytes(path: string, baseRoot?: string | null) {
  return invokeDesktop<DesktopArtifactBytes>('desktop_chat_artifact_bytes', { path, baseRoot });
}

export type DesktopArtifactThumbnail = { pngBase64: string; sizeBytes: number };

/** A Quick Look thumbnail of an artifact (PDF, Office, Keynote, images, video), with its size. */
export async function fetchDesktopChatArtifactThumbnail(path: string, baseRoot?: string | null) {
  return invokeDesktop<DesktopArtifactThumbnail>('desktop_chat_artifact_thumbnail', { path, baseRoot });
}

/** Shows an artifact in the system Quick Look panel. */
export async function openDesktopChatArtifactQuickLook(path: string, baseRoot?: string | null) {
  return invokeDesktop<void>('desktop_chat_artifact_quick_look', { path, baseRoot });
}
