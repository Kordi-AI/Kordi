import { ArrowUpRight, Eye, FileText } from 'lucide-react';

/**
 * A file the panel does not draw itself (Office, Keynote, audio, video, archives): its Quick Look
 * thumbnail, name, and kind, with Quick Look and Open in default app. Centered in the panel.
 */
export function FileCard({ name, details, thumbnail, onQuickLook, onOpenExternal }: {
  name: string;
  details: string;
  thumbnail?: string | null;
  onQuickLook?: () => void;
  onOpenExternal?: () => void;
}) {
  return (
    <div className="app-file-card" data-file-card="">
      <div className="app-file-card-body">
        {thumbnail ? (
          <img className="app-file-card-thumbnail" src={thumbnail} alt="" draggable={false} />
        ) : (
          <span className="app-file-card-glyph" aria-hidden="true"><FileText size={28} strokeWidth={1.5} /></span>
        )}
        <h3 className="app-file-card-name">{name}</h3>
        <p className="app-file-card-details">{details}</p>
        {onQuickLook || onOpenExternal ? (
          <div className="app-file-card-actions">
            {onQuickLook ? <button type="button" className="app-file-card-primary" onClick={onQuickLook}><Eye size={14} aria-hidden="true" />Quick Look</button> : null}
            {onOpenExternal ? <button type="button" onClick={onOpenExternal}><ArrowUpRight size={14} aria-hidden="true" />Open in default app</button> : null}
          </div>
        ) : (
          <p className="app-file-card-details">Open this file in the Kordi desktop app.</p>
        )}
      </div>
    </div>
  );
}
