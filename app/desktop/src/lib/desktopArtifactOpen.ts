import { invokeDesktop } from './desktop';

/** Opens an artifact file in its default app; the path resolves like a preview. */
export async function openDesktopChatArtifact(path: string, baseRoot?: string | null) {
  return invokeDesktop<string>('desktop_chat_artifact_open', { path, baseRoot });
}

/** Opens a fresh copy of a shared document's text, under `name`, in its default app. */
export async function openDesktopChatArtifactCopy(name: string, contents: string) {
  return invokeDesktop<string>('desktop_chat_artifact_open_copy', { name, contents });
}
