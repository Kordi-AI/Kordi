import { invokeDesktop } from '@/lib/desktop';

export async function revealDesktopAttachment(path: string) {
  return invokeDesktop<string>('desktop_reveal_in_finder', { path });
}

export async function saveDesktopAttachmentAs(path: string, name?: string | null) {
  return invokeDesktop<string | null>('desktop_save_attachment_as', { path, name: name ?? null });
}

/** Saves generated text: a Save dialog on the Mac, a download in the browser. Null when cancelled. */
export async function saveDesktopTextFileAs(name: string, contents: string) {
  return invokeDesktop<string | null>('desktop_save_text_file_as', { name, contents });
}
