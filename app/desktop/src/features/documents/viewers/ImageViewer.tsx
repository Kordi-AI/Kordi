import { useState } from 'react';

type Zoom = 'fit' | number;
const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** The next zoom step in or out from the current scale. */
function stepZoom(scale: number, direction: 1 | -1) {
  if (direction > 0) return STEPS.find((step) => step > scale + 0.001) ?? STEPS[STEPS.length - 1];
  return [...STEPS].reverse().find((step) => step < scale - 0.001) ?? STEPS[0];
}

/**
 * An image that fills the panel on a neutral backdrop: Fit by default, 100%, and zoom steps.
 * Transparent areas show a checkerboard. The size reports once the image decodes.
 */
export function ImageViewer({ src, name, onSize }: { src: string; name: string; onSize?: (size: { width: number; height: number }) => void }) {
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const scale = zoom === 'fit' ? 1 : zoom;

  if (failed) return <p className="app-viewer-empty">This image could not be shown.</p>;
  return (
    <div className="app-image-viewer" data-image-viewer="" data-zoom={zoom === 'fit' ? 'fit' : 'scaled'}>
      <div className="app-image-viewer-scroll">
        <div className="app-image-viewer-stage">
          <img
            src={src}
            alt={name}
            draggable={false}
            style={zoom === 'fit' || !natural ? undefined : { width: natural.width * scale, height: natural.height * scale }}
            onLoad={(event) => {
              const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
              setNatural(size);
              onSize?.(size);
            }}
            onError={() => setFailed(true)}
          />
        </div>
      </div>
      <div className="app-image-viewer-zoom" role="group" aria-label="Zoom">
        <button type="button" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>Fit</button>
        <button type="button" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>100%</button>
        <button type="button" aria-label="Zoom out" onClick={() => setZoom(stepZoom(scale, -1))}>−</button>
        <button type="button" aria-label="Zoom in" onClick={() => setZoom(stepZoom(scale, 1))}>+</button>
      </div>
    </div>
  );
}
