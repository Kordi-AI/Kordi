/**
 * A PDF in WebKit's built-in viewer (the one Safari uses), filling the panel: scrolling pages,
 * zoom, and text selection come from the system at no bundle cost. `src` is an object URL.
 */
export function PdfViewer({ src, name }: { src: string; name: string }) {
  return <iframe className="app-pdf-viewer" data-pdf-viewer="" title={name} src={src} />;
}
