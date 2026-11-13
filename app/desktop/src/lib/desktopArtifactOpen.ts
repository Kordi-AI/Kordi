import { invokeDesktop } from './desktop';

/** Opens an artifact file in its default app; the path resolves like a preview. */
export async function openDesktopChatArtifact(path: string, baseRoot?: string | null) {
  return invokeDesktop<string>('desktop_chat_artifact_open', { path, baseRoot });
}

/** Opens a fresh copy of a shared document's text, under `name`, in its default app. */
export async function openDesktopChatArtifactCopy(name: string, contents: string) {
  return invokeDesktop<string>('desktop_chat_artifact_open_copy', { name, contents });
}

export type DesktopArtifactImage = { path: string; mimeType: string; sizeBytes: number; dataBase64: string };

/** Reads an image artifact for the image viewer and card thumbnails; the path resolves like a preview. */
export async function fetchDesktopChatArtifactImage(path: string, baseRoot?: string | null) {
  return invokeDesktop<DesktopArtifactImage>('desktop_chat_artifact_image', { path, baseRoot });
}
