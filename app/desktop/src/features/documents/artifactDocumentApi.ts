import { documentShareApiForEnvironment, type DocumentShareApi } from '@/features/documents/documentShareApi';

/** What the Artifacts tab reads from cloud documents, for card thumbnails and opening copies. */
export type ArtifactDocumentApi = Pick<DocumentShareApi, 'getDocument' | 'getDocumentRaw'>;

// Kept apart from the lazy card chunk: the list's open action needs it at startup too.
let apiOverride: ArtifactDocumentApi | null | undefined;

/** Lets tests and the login-free visual page read cloud documents from memory. */
export function setArtifactDocumentApiForPreview(api: ArtifactDocumentApi | null | undefined) {
  apiOverride = api;
}

/** The server API for reading cloud documents, or the preview's in-memory one. */
export function artifactDocumentApi(): ArtifactDocumentApi | null {
  if (apiOverride !== undefined) return apiOverride;
  try {
    return documentShareApiForEnvironment();
  } catch {
    return null;
  }
}
