export type TourRect = { left: number; top: number; width: number; height: number };
type Side = 'right' | 'bottom' | 'left' | 'top';

/** Keep the coachmark beside its target and inside the visible viewport. */
export function helpTourGeometry(target: TourRect | null, viewport: { width: number; height: number }, panel: { width: number; height: number }) {
  const margin = 12;
  const gap = 16;
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, Math.max(margin, max)));
  if (!target) return { left: clamp(64, viewport.width - panel.width - margin), top: clamp(viewport.height - panel.height - 20, viewport.height - panel.height - margin), side: 'none', arrow: 0 };
  const right = target.left + target.width;
  const bottom = target.top + target.height;
  // Space left over on each side once the panel sits there. Take the first side that fits, in reading
  // order, so the panel lands in open space next to the target instead of across the window; when
  // none fits, take the roomiest side and let the clamp keep the panel on screen.
  const spare: Record<Side, number> = {
    right: viewport.width - margin - right - gap - panel.width,
    bottom: viewport.height - margin - bottom - gap - panel.height,
    left: target.left - gap - margin - panel.width,
    top: target.top - gap - margin - panel.height,
  };
  const sides: readonly Side[] = ['right', 'bottom', 'left', 'top'];
  const side = sides.find((name) => spare[name] >= 0) ?? [...sides].sort((a, b) => spare[b] - spare[a])[0];
  const vertical = side === 'left' || side === 'right';
  // A wide or tall target anchors the panel at its start edge, not at a far-away center.
  const wide = !vertical && target.width > panel.width * 1.4;
  const tall = vertical && target.height > panel.height * 1.4;
  const left = clamp(side === 'right' ? right + gap : side === 'left' ? target.left - gap - panel.width
    : wide ? target.left : target.left + target.width / 2 - panel.width / 2, viewport.width - panel.width - margin);
  const top = clamp(side === 'bottom' ? bottom + gap : side === 'top' ? target.top - gap - panel.height
    : tall ? target.top : target.top + target.height / 2 - panel.height / 2, viewport.height - panel.height - margin);
  const aim = vertical
    ? (tall ? target.top + 28 : target.top + target.height / 2) - top
    : (wide ? target.left + 40 : target.left + target.width / 2) - left;
  const arrow = Math.max(20, Math.min(aim, (vertical ? panel.height : panel.width) - 20));
  return { left, top, side, arrow };
}

export type TourBox = { left: number; top: number; right: number; bottom: number };

/**
 * The spotlight around a target: the same pad on every side so the ring stays centered on it, trimmed
 * evenly when the window edge or a clipping container is close. On an axis where the target itself is
 * cut off, the ring covers the visible part plus the pad, kept `inset` away from the window edge.
 */
export function helpTourRing(target: TourBox, clip: TourBox, viewport: { width: number; height: number }, pad = 5, inset = 4): TourRect | null {
  if (target.right <= clip.left || target.left >= clip.right || target.bottom <= clip.top || target.top >= clip.bottom) return null;
  const fitsX = target.left >= clip.left && target.right <= clip.right;
  const fitsY = target.top >= clip.top && target.bottom <= clip.bottom;
  const room = [pad];
  if (fitsX) room.push(target.left - clip.left, clip.right - target.right);
  if (fitsY) room.push(target.top - clip.top, clip.bottom - target.bottom);
  const even = Math.max(0, Math.min(...room));
  const axis = (fits: boolean, start: number, end: number, min: number, max: number, size: number) => fits
    ? [start - even, end + even]
    : [Math.max(min, inset, start - pad), Math.min(max, size - inset, end + pad)];
  const [left, right] = axis(fitsX, target.left, target.right, clip.left, clip.right, viewport.width);
  const [top, bottom] = axis(fitsY, target.top, target.bottom, clip.top, clip.bottom, viewport.height);
  return { left, top, width: right - left, height: bottom - top };
}
