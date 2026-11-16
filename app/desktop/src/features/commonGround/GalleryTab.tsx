import { useState } from 'react';

import { cn } from '@/lib/utils';
import { topicTone } from './format';
import { GalleryCard } from './GalleryCard';
import { galleryTopics } from './galleryFormat';
import { GalleryShareDialog } from './GalleryShareDialog';
import type { CgState, CommonGroundStore } from './store';
import { galleryCandidatesKey, galleryRemoveKey, galleryShareKey, loadCandidates, removeFromGallery, shareToGallery } from './storeGallery';
import type { CgGalleryList } from './types';

/**
 * The room's Gallery tab: topic chips (All and the room topics that have items) with Share on the
 * right, then a grid of cards. A closed room keeps everything readable and leaves out Share.
 */
export function GalleryTab({ code, list, roomName, roomTopics, closed, state, store }: {
  code: string;
  list: CgGalleryList;
  roomName: string;
  roomTopics: string[];
  closed: boolean;
  state: CgState;
  store: CommonGroundStore;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const chips = galleryTopics(roomTopics, list.items);
  const active = filter && chips.includes(filter) ? filter : null;
  const shown = active ? list.items.filter((item) => item.topic === active) : list.items;
  const openShare = () => {
    setSharing(true);
    void loadCandidates(store, code);
  };
  const shareButton = list.canShare && !closed
    ? <button type="button" className="cg-button" data-cg-gallery-share="" onClick={openShare}>Share</button>
    : null;

  return (
    <div className="cg-gallery">
      {!list.items.length ? (
        <div className="cg-gallery-empty">
          <span className="cg-muted">Nothing shared yet</span>
          {shareButton}
        </div>
      ) : (
        <>
          {chips.length || shareButton ? (
            <div className="cg-gallery-toolbar">
              <div className="cg-gallery-chips" role="group" aria-label="Topics">
                {chips.length ? (
                  <>
                    <button type="button" className="cg-gallery-chip" aria-pressed={active === null} onClick={() => setFilter(null)}>All</button>
                    {chips.map((topic) => (
                      <button key={topic} type="button" className="cg-gallery-chip" aria-pressed={active === topic} onClick={() => setFilter(topic)}>
                        <i className={cn('cg-gallery-chip-dot', `tone-${topicTone(topic)}`)} aria-hidden="true" />
                        {topic}
                      </button>
                    ))}
                  </>
                ) : null}
              </div>
              {shareButton}
            </div>
          ) : null}
          <div className="cg-gallery-grid">
            {shown.map((item) => (
              <GalleryCard
                key={item.itemId}
                code={code}
                item={item}
                client={store.client}
                removing={state.busy === galleryRemoveKey(item.itemId)}
                onOpen={() => store.open({ name: 'galleryItem', code, itemId: item.itemId })}
                onRemove={() => void removeFromGallery(store, code, item.itemId)}
              />
            ))}
          </div>
        </>
      )}
      {sharing ? (
        <GalleryShareDialog
          roomName={roomName}
          topics={roomTopics}
          candidates={state.gallery.candidates[code]}
          loading={state.busy === galleryCandidatesKey(code)}
          busy={state.busy === galleryShareKey(code)}
          notice={state.notice}
          onCancel={() => setSharing(false)}
          onShare={(ids, topic) => void shareToGallery(store, code, ids, topic).then((shared) => {
            if (!shared) return;
            setSharing(false);
            setFilter(null);
          })}
        />
      ) : null}
    </div>
  );
}
