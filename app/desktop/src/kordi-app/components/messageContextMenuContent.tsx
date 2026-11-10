import { useState, type ReactNode } from 'react';
import { CheckCircle2, Copy, Eye, Flag, Forward, MessagesSquare, Pencil, Pin, TextQuote, Trash2 } from 'lucide-react';

import {
  attachmentMediaGalleryIndex,
  attachmentPreviewUrl,
} from '@/features/chat/attachmentMediaGallery';
import { openAttachmentMediaWindow } from '@/features/chat/attachmentMediaWindow';
import { messageSeenByTarget, SEEN_BY_PREVIEW_LIMIT } from '@/features/chat/messageSeenBy';
import { useMessageReaders, useMessageSeenBySource } from '@/features/chat/messageSeenByContext';
import { reportTargetForMessage } from '@/features/safety/reportTarget';
import { useSafetyActions } from '@/features/safety/safetyActions';
import { cn } from '@/lib/utils';
import type { Message, MessageAttachment, MessageReplyDestination } from '../types';
import { AddAttachmentToMediaLibraryAction } from './addAttachmentToMediaLibraryAction';
import { MessageReactionSurface } from './messageReactions';
import { MessageSeenByReaders, MessageSeenByRow } from './messageSeenByRow';
import { AttachmentActions } from './transcriptAttachmentActions';
import { messageStickerAttachment } from './messageStickerPresentation';
import { transcriptMessageIsOwnHuman } from './transcriptMessageHumanRole';

function Action({ icon, label, action, onClick, destructive = false }: { icon: ReactNode; label: string; action: string; onClick?: () => void; destructive?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-message-context-menu-action={action}
      className={cn('app-dense-menu-row app-message-context-menu-action', destructive && 'app-dense-menu-danger')}
      onClick={onClick}
    >
      <span className="app-dense-menu-icon" aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export type MessageContextMenuActionHandlers = {
  onReplyMessage?: (message: Message, destination: MessageReplyDestination) => void;
  onOpenMessageThread?: (message: Message) => void;
  onForwardMessage?: (message: Message) => void;
  onEditMessage?: (message: Message) => void;
  onDeleteMessage?: (message: Message) => void;
  onOpenMessageDetail?: (message: Message) => void;
  onSelectMessage?: (message: Message) => void;
  onRequestPinMessage?: (message: Message) => void;
  onRequestUnpinMessage?: (message: Message) => void;
  onReactMessage?: (message: Message, reaction: string) => Promise<void> | void;
  isPinned?: boolean;
};

function isActionEligible(msg: Message) {
  if (!(msg.id ?? msg.entryId ?? msg.turn?.id)) return false;
  if (msg.role === 'system' || msg.role === 'action' || msg.role === 'edit') return false;
  return !msg.turn || msg.turn.completed;
}

function messageCanEdit(msg: Message) {
  const status = new Set((msg.statusChips ?? []).map((value) => value.trim().toLowerCase()));
  return isActionEligible(msg)
    && !(msg.messageAction?.kind === 'forward' && msg.messageAction.forwardedContent)
    && transcriptMessageIsOwnHuman(msg)
    && msg.senderType === 'human'
    && Boolean(msg.text.trim())
    && Boolean(msg.reactionConversationId && msg.reactionTargetMessageId)
    && Number.isInteger(msg.cloudMessageVersion)
    && Number(msg.cloudMessageVersion) > 0
    && !status.has('sending')
    && !status.has('failed')
    && !['voice', 'sticker', 'call'].includes(msg.messageKind?.trim().toLowerCase() ?? '');
}

function messageCanDelete(msg: Message) {
  return isActionEligible(msg)
    && msg.senderType === 'human'
    && Boolean(msg.reactionConversationId && msg.reactionTargetMessageId);
}

export function MessageContextMenuContent({
  msg,
  onClose,
  onReplyMessage,
  onOpenMessageThread,
  onForwardMessage,
  onEditMessage,
  onDeleteMessage,
  onSelectMessage,
  onRequestPinMessage,
  onRequestUnpinMessage,
  onReactMessage,
  isPinned = false,
  mediaAttachment,
  mediaGallery,
}: {
  msg: Message;
  onClose?: () => void;
  mediaAttachment?: MessageAttachment | null;
  mediaGallery?: readonly MessageAttachment[];
} & MessageContextMenuActionHandlers) {
  const [showsAllReactions, setShowsAllReactions] = useState(false);
  // 'actions' after returning from the readers list, so the Seen row takes focus back.
  const [view, setView] = useState<'initial' | 'readers' | 'actions'>('initial');
  const seenBySource = useMessageSeenBySource();
  const seenByTarget = messageSeenByTarget(msg, seenBySource);
  const seenByPreview = useMessageReaders(seenBySource, seenByTarget, SEEN_BY_PREVIEW_LIMIT);
  const showsReaders = view === 'readers' && Boolean(seenBySource && seenByTarget);
  const copyableText = msg.text.trim() || msg.turn?.assistantText?.trim() || msg.detail?.trim() || '';
  const stickerAttachment = messageStickerAttachment(msg);
  const actionEligible = isActionEligible(msg);
  const canEdit = Boolean(onEditMessage && messageCanEdit(msg));
  const canDelete = Boolean(onDeleteMessage && messageCanDelete(msg));
  const safety = useSafetyActions();
  const reportTarget = safety.available && actionEligible ? reportTargetForMessage(msg) : null;
  const canReact = actionEligible
    && Boolean(msg.reactionConversationId && msg.reactionTargetMessageId && onReactMessage);
  const closeAfter = (action?: (message: Message) => void) => {
    action?.(msg);
    onClose?.();
  };
  const closeAfterReply = (destination: MessageReplyDestination) => {
    if (destination === 'thread') onOpenMessageThread?.(msg);
    else onReplyMessage?.(msg, destination);
    onClose?.();
  };
  const copyText = async () => {
    if (!copyableText) return;
    try {
      await navigator.clipboard?.writeText(copyableText);
    } catch {
      // Closing the menu is enough recovery for an unavailable clipboard.
    } finally {
      onClose?.();
    }
  };
  const handleReaction = (reaction: string) => {
    onClose?.();
    void onReactMessage?.(msg, reaction);
  };
  const reviewMediaAttachment = () => {
    if (!mediaAttachment) return;
    const attachments = mediaGallery?.length ? [...mediaGallery] : [mediaAttachment];
    const galleryIndex = attachmentMediaGalleryIndex(attachments, mediaAttachment);
    onClose?.();
    void openAttachmentMediaWindow({
      attachments,
      selectedIndex: galleryIndex >= 0 ? galleryIndex : 0,
      initialPreviewUrl: attachmentPreviewUrl(mediaAttachment),
    }).catch(() => undefined);
  };

  return (
    <div
      className={cn(
        'app-message-context-menu-content max-w-[calc(100vw-1rem)]',
        canReact ? 'w-[17.5rem]' : 'w-[13.5rem]',
      )}
      data-message-context-menu-content="true"
      data-message-context-menu-reactions={canReact || undefined}
    >
      {canReact ? (
        <MessageReactionSurface
          expanded={showsAllReactions}
          onReact={handleReaction}
          onToggleExpanded={() => setShowsAllReactions((current) => !current)}
        />
      ) : null}
      {!showsAllReactions && showsReaders && seenBySource && seenByTarget ? (
        <div className="app-transient-surface app-dense-menu app-message-context-menu-list overflow-hidden">
          <MessageSeenByReaders
            source={seenBySource}
            target={seenByTarget}
            placeholder={seenByPreview?.status === 'ready' ? seenByPreview.page.readers : []}
            onBack={() => setView('actions')}
          />
        </div>
      ) : null}
      {!showsAllReactions && !showsReaders ? <div className="app-transient-surface app-dense-menu app-message-context-menu-list overflow-hidden">
        {mediaAttachment ? (
          <>
            <Action action="review-attachment" icon={<Eye className="h-4 w-4" />} label="Review" onClick={reviewMediaAttachment} />
            <AttachmentActions attachment={mediaAttachment} variant="menu" />
            <AddAttachmentToMediaLibraryAction attachment={mediaAttachment} onAdded={() => onClose?.()} />
            <div className="app-dense-menu-divider" role="separator" />
          </>
        ) : null}
        {actionEligible && onReplyMessage ? <Action action="quote" icon={<TextQuote className="h-4 w-4" />} label="Quote" onClick={() => closeAfterReply('conversation')} /> : null}
        {actionEligible && onOpenMessageThread ? <Action action="open-discussion" icon={<MessagesSquare className="h-4 w-4" />} label="Open discussion" onClick={() => closeAfterReply('thread')} /> : null}
        {actionEligible && (onReplyMessage || onOpenMessageThread) ? <div className="app-dense-menu-divider" role="separator" /> : null}
        {canEdit ? <Action action="edit" icon={<Pencil className="h-4 w-4" />} label="Edit" onClick={() => closeAfter(onEditMessage)} /> : null}
        {copyableText ? <Action action="copy-text" icon={<Copy className="h-4 w-4" />} label="Copy" onClick={() => void copyText()} /> : null}
        {actionEligible ? <Action action="forward" icon={<Forward className="h-4 w-4" />} label="Forward" onClick={() => closeAfter(onForwardMessage)} /> : null}
        {stickerAttachment ? <AddAttachmentToMediaLibraryAction attachment={{ ...stickerAttachment, subtype: 'sticker' }} onAdded={() => onClose?.()} /> : null}
        {actionEligible && (onRequestPinMessage || onRequestUnpinMessage) ? (
          isPinned
            ? <Action action="unpin" icon={<Pin className="h-4 w-4" />} label="Unpin" onClick={() => closeAfter(onRequestUnpinMessage)} />
            : <Action action="pin" icon={<Pin className="h-4 w-4" />} label="Pin" onClick={() => closeAfter(onRequestPinMessage)} />
        ) : null}
        {actionEligible ? <div className="app-dense-menu-divider" role="separator" /> : null}
        {actionEligible ? <Action action="select" icon={<CheckCircle2 className="h-4 w-4" />} label="Select" onClick={() => closeAfter(onSelectMessage)} /> : null}
        {reportTarget ? <Action action="report" icon={<Flag className="h-4 w-4" />} label="Report" onClick={() => { onClose?.(); safety.openReport(reportTarget); }} /> : null}
        {canDelete ? <Action action="delete" icon={<Trash2 className="h-4 w-4" />} label="Delete" destructive onClick={() => closeAfter(onDeleteMessage)} /> : null}
        {seenBySource && seenByTarget ? (
          <MessageSeenByRow
            source={seenBySource}
            request={seenByPreview}
            autoFocus={view === 'actions'}
            onOpen={() => setView('readers')}
          />
        ) : null}
      </div> : null}
    </div>
  );
}
