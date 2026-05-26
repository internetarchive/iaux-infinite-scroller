import { isDocumentScroller } from './scroll-container-utils';

/**
 * A captured anchor cell + the viewport-relative `top` position where it
 * was sitting at capture time. Restoring the anchor adjusts `scrollTop`
 * so that the same cell ends up at the same viewport-relative position.
 */
export type ScrollAnchorPoint = {
  cell: HTMLDivElement;
  viewportOffset: number;
};

/**
 * Methods the `ScrollAnchor` needs to read host state without owning
 * the underlying fields.
 */
export interface ScrollAnchorHostInterface {
  /** Nearest scrolling ancestor (cached by the host). */
  getScrollContainer(): Element;

  /** All cell containers currently in DOM order. */
  getCellContainers(): Iterable<HTMLDivElement>;

  /** Indices of cells whose content (not placeholder) is currently rendered. */
  getRenderedCellIndices(): ReadonlySet<number>;

  /**
   * Returns false when anchor capture should short-circuit, typically
   * because virtualization is off or a programmatic scroll is in progress.
   */
  isActive(): boolean;
}

/**
 * Captures and restores a "scroll anchor": a reference to the topmost
 * visible cell, plus its viewport-relative position. The host can use this
 * to keep the user's view stable across operations that shift cell positions.
 *
 * Also owns the "suppress next scroll event" flag, which prevents the
 * recursive case where restoring a scroll anchor triggers scroll listeners
 * that would then attempt to re-anchor and oscillate.
 *
 * The host is responsible for the timing of capture/restore, typically
 * capturing before mutating the cell buffer, holding the anchor until needed,
 * then restoring once the layout has settled.
 */
export class ScrollAnchor {
  /**
   * Prevents the next anchoring adjustment from itself triggering a re-anchor.
   */
  private suppressNextScrollEvent = false;

  private host: ScrollAnchorHostInterface;

  constructor(host: ScrollAnchorHostInterface) {
    this.host = host;
  }

  /**
   * Find a cell to use as the scroll anchor and record its
   * viewport-relative top position. Pair every call with `restore`.
   *
   * The capture prioritizes cells in this order:
   *  1. The topmost visible fully-rendered cell.
   *  2. The first fully-rendered cell below the viewport, if no visible
   *     one exists.
   *  3. The topmost visible cell, which may be a placeholder.
   *
   * If there are no fully-rendered cells yet, we short-circuit to the
   * topmost visible cell since there's nothing better to look for.
   */
  capture(): ScrollAnchorPoint | null {
    if (!this.host.isActive()) return null;

    const scrollContainer = this.host.getScrollContainer();
    const isDoc = isDocumentScroller(scrollContainer);
    const viewportTop = isDoc ? 0 : scrollContainer.getBoundingClientRect().top;
    const viewportBottom = isDoc
      ? window.innerHeight
      : viewportTop + scrollContainer.clientHeight;

    const renderedIndices = this.host.getRenderedCellIndices();
    const hasRenderedCells = renderedIndices.size > 0;

    let visibleFallback: ScrollAnchorPoint | null = null;
    let belowRendered: ScrollAnchorPoint | null = null;
    for (const cell of this.host.getCellContainers()) {
      const rect = cell.getBoundingClientRect();
      const idxStr = cell.dataset.cellIndex;
      if (idxStr === undefined) {
        // No cellIndex on this element, skip
      } else {
        const idx = Number(idxStr);
        const anchor: ScrollAnchorPoint = {
          cell,
          viewportOffset: rect.top - viewportTop,
        };
        if (rect.bottom < viewportTop) {
          // Still fully above the viewport; skip.
        } else if (rect.top >= viewportBottom) {
          // Below the viewport. If we reach this point and find a rendered
          // cell we should use it.
          if (hasRenderedCells && renderedIndices.has(idx)) {
            belowRendered = anchor;
            break;
          }
        } else if (hasRenderedCells && renderedIndices.has(idx)) {
          // Best case: visible & rendered, return immediately.
          return anchor;
        } else if (!visibleFallback) {
          // Visible but only rendering a placeholder at best.
          // If no cells are rendered, this is the best we can do, so short-circuit.
          // Otherwise save it as a fallback.
          visibleFallback = anchor;
          if (!hasRenderedCells) return visibleFallback;
        }
      }
    }

    return belowRendered ?? visibleFallback;
  }

  /**
   * After a state mutation that may have shifted the visible content,
   * adjust `scrollTop` so the previously-captured anchor cell stays at
   * the same viewport-relative position.
   */
  restore(anchor: ScrollAnchorPoint | null): void {
    if (!anchor) return;
    // The anchor cell may have been removed from the DOM if the buffer shifted
    // so far that it's no longer rendered. In that case we can just skip
    // anchoring because there's no longer much point.
    if (!anchor.cell.isConnected) return;

    const scrollContainer = this.host.getScrollContainer();
    const isDoc = isDocumentScroller(scrollContainer);
    const viewportTop = isDoc ? 0 : scrollContainer.getBoundingClientRect().top;
    const newRect = anchor.cell.getBoundingClientRect();
    const delta = newRect.top - viewportTop - anchor.viewportOffset;

    // For very small deltas, we just skip them to avoid scroll jitter.
    if (Math.abs(delta) < 0.5) return;

    this.suppressNextScrollEvent = true;
    if (isDoc) {
      window.scrollBy(0, delta);
    } else {
      scrollContainer.scrollTop += delta;
    }
  }

  /**
   * Returns true exactly once after a call to `restore()` that actually
   * adjusted the scroll position. Use this to prevent anchoring adjustments
   * from themselves re-triggering a buffer recompute.
   */
  shouldSuppressNextScrollEvent(): boolean {
    if (!this.suppressNextScrollEvent) return false;
    this.suppressNextScrollEvent = false;
    return true;
  }
}
