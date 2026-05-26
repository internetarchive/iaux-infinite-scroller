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
 * Callbacks the `ScrollAnchor` needs to read host state without owning
 * the underlying fields. Implementations are typically thin arrow
 * functions on the host class.
 */
export interface ScrollAnchorHostInterface {
  /** Nearest scrolling ancestor (cached by the host). */
  getScrollContainer(): Element;

  /** All cell containers currently in DOM order. */
  getCellContainers(): Iterable<HTMLDivElement>;

  /** Indices of cells whose content (not placeholder) is currently rendered. */
  getRenderedCellIndices(): ReadonlySet<number>;

  /**
   * Returns false when anchor capture should short-circuit — typically
   * because virtualization is off or a programmatic scroll is in progress.
   */
  isActive(): boolean;
}

/**
 * Captures and restores a "scroll anchor": a reference to the topmost
 * visible cell, plus its viewport-relative position. Used by the host to
 * keep the user's view stable across operations that shift cell positions
 * (buffer extensions, placeholder→content transitions, etc.).
 *
 * Also owns the "suppress next scroll event" flag, which prevents the
 * recursive case where restoring a scroll anchor triggers `scrollend`/
 * `scroll` listeners that would then re-anchor and oscillate.
 *
 * The host is responsible for the timing of capture/restore, typically
 * capturing pre-mutation, holding the anchor until needed, then restoring
 * once the layout has settled.
 */
export class ScrollAnchor {
  /**
   * Set by `restore()` when it adjusts `scrollTop`, consumed (and
   * cleared) by `shouldSuppressNextScrollEvent()` at the top of the
   * host's scroll handler. Prevents the anchoring adjustment from itself
   * triggering a re-anchor.
   */
  private suppressNextScrollEvent = false;

  private host: ScrollAnchorHostInterface;

  constructor(host: ScrollAnchorHostInterface) {
    this.host = host;
  }

  /**
   * Find the topmost cell currently visible in the viewport and record
   * its viewport-relative top position. Pair every call with `restore`.
   *
   * Prefers a **rendered (content) cell** over a placeholder when one is
   * visible, since anchoring actual cell content is more important than
   * anchoring generic placeholder graphics. Falls back to the topmost
   * visible placeholder when no rendered cell is in view.
   */
  capture(): ScrollAnchorPoint | null {
    if (!this.host.isActive()) return null;

    const scrollContainer = this.host.getScrollContainer();
    const isDoc = isDocumentScroller(scrollContainer);
    const viewportTop = isDoc ? 0 : scrollContainer.getBoundingClientRect().top;
    const viewportBottom = isDoc
      ? window.innerHeight
      : viewportTop + scrollContainer.clientHeight;

    // Walk cells in DOM order (= index order). For each visible cell,
    // remember the first one we see as a fallback. As soon as we find a
    // visible *rendered* cell, return it immediately. Stop iterating once
    // we pass the viewport bottom.
    //
    // If there's no rendered content anywhere in the buffer (e.g. the
    // user just jumped to an unloaded region), short-circuit to the first
    // visible cell — no point walking the viewport looking for content
    // that doesn't exist.
    const renderedIndices = this.host.getRenderedCellIndices();
    const lookForContent = renderedIndices.size > 0;
    let fallback: ScrollAnchorPoint | null = null;
    for (const cell of this.host.getCellContainers()) {
      const rect = cell.getBoundingClientRect();
      if (rect.top >= viewportBottom) break;
      if (rect.bottom >= viewportTop) {
        const idxStr = cell.dataset.cellIndex;
        if (idxStr !== undefined) {
          const anchor: ScrollAnchorPoint = {
            cell,
            viewportOffset: rect.top - viewportTop,
          };
          if (lookForContent && renderedIndices.has(Number(idxStr))) {
            return anchor;
          }
          if (!fallback) {
            fallback = anchor;
            if (!lookForContent) return fallback;
          }
        }
      }
    }
    return fallback;
  }

  /**
   * After a state mutation that may have shifted the visible content,
   * adjust `scrollTop` so the previously-captured anchor cell stays at
   * the same viewport-relative position.
   */
  restore(anchor: ScrollAnchorPoint | null): void {
    if (!anchor) return;
    // The anchor cell may have been removed from the DOM if the buffer
    // shifted such that it's no longer rendered. Skip in that case — the
    // user will still see *some* cell, and the next scroll event will
    // settle things.
    if (!anchor.cell.isConnected) return;

    const scrollContainer = this.host.getScrollContainer();
    const isDoc = isDocumentScroller(scrollContainer);
    const viewportTop = isDoc ? 0 : scrollContainer.getBoundingClientRect().top;
    const newRect = anchor.cell.getBoundingClientRect();
    const delta = newRect.top - viewportTop - anchor.viewportOffset;
    // Sub-pixel deltas can result from fractional layout math; skip them
    // to avoid jitter on hidpi displays.
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
   * adjusted the scroll position. The host's scroll handler calls this
   * at the top of its callback and bails out if true, so the anchoring
   * adjustment doesn't itself re-trigger a buffer recompute.
   */
  shouldSuppressNextScrollEvent(): boolean {
    if (!this.suppressNextScrollEvent) return false;
    this.suppressNextScrollEvent = false;
    return true;
  }
}
