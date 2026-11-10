import type { Editor } from '@tiptap/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { NO_COLLAB } from '../documentPresence';
import { DocumentEditorSurface, type DocumentEditorProps, type SurfaceOutput } from './DocumentEditorSurface';
import { legacyIdsFor } from './documentEditorSync';
import { newBlockId } from '../newBlockId';
import type { DocumentRoom, DocumentRoomOptions, ProviderFactory } from './documentRoom';
import { DocumentRoomSync, prepareRoom } from './documentRoomSync';

export type { DocumentEditorHandle, DocumentEditorProps } from './DocumentEditorSurface';

type Props = DocumentEditorProps & {
  /** Replaces the socket provider (tests). */
  createProvider?: ProviderFactory;
  /** Shorter room waits (tests). */
  roomTiming?: DocumentRoomOptions['timing'];
  /** The room, after it is created and before it connects (tests). */
  onRoom?: (room: DocumentRoom) => void;
};

/**
 * The lazy editor entry. Editable cloud documents join their collaboration
 * room: once the room has synced and has content, the editor's unsaved edits
 * go into it and the editor is bound to its Y document, staying bound across
 * reconnects. Until then (ticket refused, offline) it edits with revisioned
 * saves.
 */
export function DocumentEditor(props: Props) {
  const output = useRef<SurfaceOutput>({ markdown: null, blockIds: null, base: [] });
  const seedEditor = useRef<Editor | null>(null);
  // Index ids (`b3`) of a document saved before ids existed get `k:` ids once; after its first stamped save the server lists only `k:` ids.
  const [initialLegacyIds] = useState(() => legacyIdsFor(props.blocks, newBlockId));
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });
  const [joined, setJoined] = useState<DocumentRoomSync | null>(null);
  const [synced, setSynced] = useState(false);
  const [ready, setReady] = useState<DocumentRoom | null>(null);

  const attachmentId = props.collab?.attachmentId ?? null;
  const api = props.collab?.api ?? null;
  const accountId = props.collab?.user.accountId ?? null;
  useEffect(() => {
    const collab = latest.current.collab;
    if (!collab || !api || !attachmentId || !accountId) return undefined;
    // After `destroy()` the room calls none of these (it may still deliver offline edits in the background).
    const created = new DocumentRoomSync({
      api,
      attachmentId,
      user: collab.user,
      createProvider: latest.current.createProvider,
      timing: latest.current.roomTiming,
      legacyIds: initialLegacyIds,
      blockIds: () => output.current.blockIds,
      onChange: () => {
        setSynced(created.room.synced);
        latest.current.onCollab?.({ status: created.room.status, peers: created.room.peers(), bound: created.room.bound });
      },
      onSnapshot: (document) => latest.current.onSnapshot?.(document),
      onUpdatedElsewhere: () => latest.current.onUpdatedElsewhere?.(),
    });
    latest.current.onRoom?.(created.room);
    setJoined(created);
    created.room.start();
    return () => {
      created.room.destroy();
      setJoined(null);
      setSynced(false);
      latest.current.onCollab?.(NO_COLLAB);
    };
  }, [accountId, api, attachmentId, initialLegacyIds]);

  useEffect(() => {
    if (!joined || !synced || !api || !attachmentId) return undefined;
    return prepareRoom(joined, {
      editor: () => seedEditor.current,
      base: () => output.current.base,
      held: () => latest.current.storeDocument ?? null,
      latest: () => api.getDocument(attachmentId).catch(() => null),
    }, () => setReady(joined.room));
  }, [api, attachmentId, joined, synced]);

  const bound = joined && ready === joined.room ? joined : null;
  // Saves made outside the room reach it through the documents the view refetches.
  const storeDocument = props.storeDocument ?? null;
  useEffect(() => {
    if (bound && storeDocument) bound.learn(storeDocument);
  }, [bound, storeDocument]);

  return (
    <DocumentEditorSurface
      key={bound ? 'room' : 'revisioned'}
      {...props}
      room={bound?.room ?? null}
      user={bound ? props.collab?.user ?? null : null}
      output={output}
      initialLegacyIds={initialLegacyIds}
      onEditor={(editor) => {
        if (bound) bound.attachEditor(editor);
        else seedEditor.current = editor;
        props.onEditor?.(editor);
      }}
    />
  );
}

export default DocumentEditor;
