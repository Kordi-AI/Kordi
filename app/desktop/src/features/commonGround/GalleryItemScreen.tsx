import { useState, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';

import { OPEN_ARTIFACT_FAILED } from '@/features/documents/openArtifactExternally';
import { isNativeDesktopShell } from '@/lib/desktop';
import { roomTitle } from './format';
import { GalleryComments } from './GalleryComments';
import { galleryAuthor, galleryKind, galleryMessageDraft, galleryViewKind } from './galleryFormat';
import { GalleryItemBody } from './GalleryItemBody';
import { openGalleryItemExternally } from './galleryOpen';
import { GalleryMenu } from './GalleryParts';
import type { CgHost } from './host';
import { CgAvatar, CgBack, CgButton, CgNotice, CgProgress } from './parts';
import { CONTACT_ACTION_LABELS } from './relationship';
import { roomClosed, type CgState, type CommonGroundStore } from './store';
import { galleryItemFor, galleryItemKey, galleryRemoveKey, removeFromGallery } from './storeGallery';
import type { CgGalleryItem } from './types';
import { useGalleryContent } from './useGalleryContent';
import { usePersonContact } from './usePersonContact';

type ScreenProps = { state: CgState; store: CommonGroundStore; host: CgHost };

/**
 * The sharer's contact control, from the same relationship rules as a person's page: Message for a
 * contact (the chat opens with "About …" in the composer), Add, then Requested, or Accept.
 */
function SharerContact({ item, state, store, host }: ScreenProps & { item: CgGalleryItem }) {
  const contact = usePersonContact(item.person, state, store, host);
  const { action, busy } = contact;
  if (action === 'hidden' || (action === 'message' && !state.support.chat)) return null;
  if (action === 'requested') return <CgButton quiet disabled>{CONTACT_ACTION_LABELS.requested}</CgButton>;
  const run = action === 'message' ? () => contact.openChat(galleryMessageDraft(item.title)) : action === 'accept' ? contact.accept : contact.add;
  return <CgButton disabled={busy} onClick={run}>{CONTACT_ACTION_LABELS[action]}</CgButton>;
}

function ItemDetail({ code, item, back, state, store, host }: ScreenProps & { code: string; item: CgGalleryItem; back: ReactNode }) {
  const kind = galleryViewKind(galleryKind(item.fileName, item.contentType), item.sizeBytes);
  const content = useGalleryContent(store.client, code, item.itemId, kind);
  const [openFailed, setOpenFailed] = useState(false);
  const text = content.status === 'ready' ? content.text : null;
  const open = text !== null && isNativeDesktopShell() ? () => {
    setOpenFailed(false);
    openGalleryItemExternally(item, text).catch(() => setOpenFailed(true));
  } : null;
  const trailing = (
    <span className="cg-row-actions">
      {item.mine
        ? <GalleryMenu className="is-inline" items={[{ label: 'Remove from gallery', onSelect: () => void removeFromGallery(store, code, item.itemId), disabled: state.busy === galleryRemoveKey(item.itemId) }]} />
        : <SharerContact item={item} state={state} store={store} host={host} />}
      {open ? (
        <button type="button" className="cg-gallery-icon-button" aria-label="Open in default app" title="Open in default app" onClick={open}>
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
  return (
    <>
      {back}
      <h1 className="cg-gallery-item-title">{item.title}</h1>
      <div className="cg-gallery-byline">
        <CgAvatar person={item.person} size={22} isSelf={item.mine} />
        <span className="cg-gallery-byline-name">{galleryAuthor(item, true)}</span>
        {item.topic ? <span className="cg-gallery-byline-topic">{item.topic}</span> : null}
        {trailing}
      </div>
      <CgNotice text={openFailed ? OPEN_ARTIFACT_FAILED : state.notice} />
      <GalleryItemBody item={item} kind={kind} content={content} />
      <GalleryComments
        code={code}
        view={state.gallery.items[galleryItemKey(code, item.itemId)]}
        closed={roomClosed(state, code)}
        state={state}
        store={store}
        host={host}
      />
    </>
  );
}

/** A Gallery item in place of the room column: title, sharer line, the file read-only, then comments. */
export function GalleryItemScreen({ code, itemId, ...props }: ScreenProps & { code: string; itemId: string }) {
  const { state, store } = props;
  const name = state.rooms[code]?.name ?? state.roomList.find((room) => room.code === code)?.name;
  const back = <CgBack label={roomTitle(code, name)} onBack={() => store.back()} />;
  const item = galleryItemFor(state, code, itemId);
  if (!item) return <>{back}{state.notice ? <CgNotice text={state.notice} /> : <CgProgress line="Loading" />}</>;
  return <ItemDetail key={item.itemId} code={code} item={item} back={back} {...props} />;
}
