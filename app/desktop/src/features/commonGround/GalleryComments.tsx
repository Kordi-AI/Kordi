import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

import { relativeTimeLabel } from '@/features/cloud/proactiveOffer';
import { galleryAuthor } from './galleryFormat';
import { GalleryMenu } from './GalleryParts';
import type { CgHost } from './host';
import { CgAvatar, CgGroup, CgSection } from './parts';
import type { CgState, CommonGroundStore } from './store';
import { addGalleryComment, deleteGalleryComment, GALLERY_COMMENT_MAX, galleryCommentKey, isPendingComment } from './storeGallery';
import type { CgGalleryComment, CgGalleryItemView } from './types';

/** The time comments are dated against, moving on each minute. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function CommentRow({ comment, now, onDelete }: { comment: CgGalleryComment; now: number; onDelete: (() => void) | null }) {
  return (
    <div className="cg-gallery-comment" data-cg-comment={comment.commentId}>
      <CgAvatar person={comment.person} size={26} isSelf={comment.mine} />
      <div className="cg-gallery-comment-text">
        <div className="cg-gallery-comment-head">
          <span className="cg-gallery-comment-name">{galleryAuthor(comment, true)}</span>
          <time className="cg-gallery-comment-time" dateTime={comment.createdAt}>{relativeTimeLabel(comment.createdAt, now)}</time>
        </div>
        <div className="cg-gallery-comment-body">{comment.body}</div>
      </div>
      {onDelete ? <GalleryMenu className="is-inline" items={[{ label: 'Delete', onSelect: onDelete }]} /> : null}
    </div>
  );
}

/** "Add a comment": Enter sends, Shift+Enter starts a new line. The field clears at once and refills if sending fails. */
function CommentForm({ busy, onSend }: { busy: boolean; onSend: (body: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState('');
  const send = () => {
    const body = draft.trim();
    if (!body || busy) return;
    setDraft('');
    void onSend(body).then((sent) => { if (!sent) setDraft((current) => current || body); });
  };
  return (
    <form className="cg-gallery-comment-form" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <textarea
        value={draft}
        rows={Math.min(6, draft.split('\n').length)}
        maxLength={GALLERY_COMMENT_MAX}
        placeholder="Add a comment"
        aria-label="Add a comment"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
      />
      <button type="submit" className="cg-gallery-send" aria-label="Send" disabled={busy || !draft.trim()}>
        <ArrowUp className="h-4 w-4" aria-hidden="true" />
      </button>
    </form>
  );
}

/**
 * Comments on an item, oldest first, then the comment field. My own comments, and every comment
 * on my item, can be deleted. A closed room shows the comments without the field.
 */
export function GalleryComments({ code, view, closed, state, store, host }: {
  code: string;
  view: CgGalleryItemView | undefined;
  closed: boolean;
  state: CgState;
  store: CommonGroundStore;
  host: CgHost;
}) {
  const now = useMinute();
  if (!view) return null;
  const { item, comments } = view;
  if (closed && !comments.length) return null;
  return (
    <CgSection title="Comments" className="cg-gallery-comments">
      {comments.length ? (
        <CgGroup>
          {comments.map((comment) => (
            <CommentRow
              key={comment.commentId}
              comment={comment}
              now={now}
              onDelete={(comment.mine || item.mine) && !isPendingComment(comment)
                ? () => void deleteGalleryComment(store, code, item.itemId, comment.commentId)
                : null}
            />
          ))}
        </CgGroup>
      ) : null}
      {closed ? null : (
        <CommentForm
          busy={state.busy === galleryCommentKey(item.itemId)}
          onSend={(body) => addGalleryComment(store, code, item.itemId, body, host.self)}
        />
      )}
    </CgSection>
  );
}
