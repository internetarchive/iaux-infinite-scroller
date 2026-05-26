import {
  LitElement,
  html,
  css,
  TemplateResult,
  CSSResultGroup,
  PropertyValues,
  render,
  nothing,
} from 'lit';
import {
  property,
  customElement,
  query,
  queryAll,
  state,
} from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import {
  findScrollContainer,
  isDocumentScroller,
} from './internal/scroll-container-utils';
import { RowHeightCache } from './internal/row-height-cache';
import { ScrollAnchor, ScrollAnchorPoint } from './internal/scroll-anchor';
import { generateRange } from './internal/range-generator';

export interface InfiniteScrollerCellProviderInterface {
  cellForIndex(index: number): TemplateResult | undefined;
}

export interface InfiniteScrollerInterface extends LitElement {
  /**
   * The number of cells to display. You may not have all the data for all the cells,
   * but you can optimistically display more tiles while you load the data that can be
   * displayed when it's loaded.
   *
   * You typically would update this when you're fetching the next batch of data.
   */
  itemCount: number;

  /**
   * The cell provider to provide cells for the scroller
   */
  cellProvider?: InfiniteScrollerCellProviderInterface;

  /**
   * A placeholder cell to display before the data has loaded
   */
  placeholderCellTemplate?: TemplateResult;

  /**
   * Disable scroll optimizations, such as lazy loading of cells
   * and removal when they're not on-screen.
   *
   * Scroll optimizations are useful for most browser-usage, but when pre-rendering with Rendertron,
   * the optimizations only show the first 10 cells and with a static page, we want
   * to see them all.
   */
  scrollOptimizationsDisabled: boolean;

  /**
   * Floor on the number of cells in the buffer, regardless of viewport
   * height. The actual buffer is
   * `max(minBufferSize, viewportRows * bufferMultiplier * cols)`.
   */
  minBufferSize: number;

  /**
   * Promise that resolves when the scroller's buffer has fully stabilized
   * after initialization or any change that triggers async measurement.
   * Consumers can await this to know when the scroller is ready for interaction.
   */
  readonly bufferStabilized: Promise<void>;

  /**
   * Multiplier for proportional buffer sizing relative to the visible row count.
   * E.g., a multiplier of 2 will result in an ideal buffer size containing approximately
   * twice as many rows as are visible.
   */
  bufferMultiplier: number;

  /**
   * Estimated height of each cell in pixels, used to size the scroll
   * spacer and position the buffer transform before real cell heights
   * have been measured. Consumers can set this to match their expected
   * content height for more accurate initial scroll positioning.
   * Defaults to the CSS `--infiniteScrollerCellMinHeight` value.
   */
  estimatedCellHeight?: number;

  /**
   * Reload the scroller
   */
  reload(): void;

  /**
   * Refreshes the content of the cell at the given index
   * @param index Which cell to refresh content for
   */
  refreshCell(index: number): void;

  /**
   * Refreshes the content of all cells within the rendered cell buffer range.
   *
   * Prefer this to the more expensive `reload()` when it is only necessary to
   * propagate a state change in the rendered cell contents and there is no need
   * for all cells to fully reload (as in the case of a major layout change).
   */
  refreshAllVisibleCells(): void;

  /**
   * Scroll to a cell index
   *
   * @param index number
   * @param animated boolean
   * @returns boolean if scroll was successful
   */
  scrollToCell(index: number, animated: boolean): Promise<boolean>;

  /**
   * Get the indices of the cells that are currently visible
   */
  getVisibleCellIndices(): number[];
}

/**
 * When the user clicks on a cell, we emit selection details
 * including the index that was selected and the original event.
 *
 * The cell DOM element can be accessed via `originalEvent.target`
 */
export type CellSelectionDetails = {
  index: number;
  originalEvent: Event;
};

/**
 * Fallback row height in pixels, used when no `estimatedCellHeight`
 * is given by the consumer and no container is mounted yet.
 * Chosen to over- rather than under-estimate, so we don't end up
 * with a too-short scrollbar.
 */
const INITIAL_ROW_HEIGHT = 300;

@customElement('infinite-scroller')
export class InfiniteScroller
  extends LitElement
  implements InfiniteScrollerInterface
{
  /** @inheritdoc */
  @property({ type: Number }) itemCount = 0;

  /** @inheritdoc */
  @property({ type: Object })
  cellProvider?: InfiniteScrollerCellProviderInterface;

  /** @inheritdoc */
  @property({ type: Object }) placeholderCellTemplate?: TemplateResult;

  /** @inheritdoc */
  @property({ type: Boolean }) scrollOptimizationsDisabled = false;

  /** The accessible label for the infinite scroller section landmark */
  @property({ type: String }) ariaLandmarkLabel?: string;

  /** @inheritdoc */
  @property({ type: Number }) minBufferSize = 10;

  /** @inheritdoc */
  @property({ type: Number }) bufferMultiplier = 1;

  /** @inheritdoc */
  @property({ type: Number }) estimatedCellHeight?: number;

  @state() private bufferStart = 0;

  @state() private bufferEnd = 0;

  @state() private rowGap = 0;

  /**
   * The sentinel is our marker to know when we need to load more data
   */
  @query('#sentinel') private sentinel?: HTMLDivElement;

  @query('#container') private container?: HTMLElement;

  @query('#scroll-spacer') private scrollSpacer?: HTMLDivElement;

  @queryAll('.cell-container') private cellContainers!: HTMLDivElement[];

  /**
   * Cache for all the cell/row tracking to ensure row heights stay
   * updated when cell heights and placeholder states change.
   *
   * Various convenience wrappers below for interacting with it.
   */
  private rowHeightCache = new RowHeightCache(INITIAL_ROW_HEIGHT);

  private get cachedColumnsPerRow(): number {
    return this.rowHeightCache.columnsPerRow;
  }

  private set cachedColumnsPerRow(colsPerRow: number) {
    this.rowHeightCache.columnsPerRow = colsPerRow;
  }

  private get defaultRowHeight(): number {
    return this.rowHeightCache.defaultRowHeight;
  }

  private set defaultRowHeight(newHeight: number) {
    this.rowHeightCache.defaultRowHeight = newHeight;
  }

  private get cellHeights(): ReadonlyMap<number, number> {
    return this.rowHeightCache.cellHeights;
  }

  private get rowHeights(): ReadonlyMap<number, number> {
    return this.rowHeightCache.rowHeights;
  }

  private get placeholderRowHeight(): number | undefined {
    return this.rowHeightCache.placeholderRowHeight;
  }

  private set placeholderRowHeight(newHeight: number | undefined) {
    this.rowHeightCache.placeholderRowHeight = newHeight;
  }

  private totalContentHeight = 0;

  private bufferOffsetY = 0;

  /**
   * Whether CSS Grid is supported in the current browser (our virtualization
   * depends on it).
   */
  private supportsGrid =
    typeof CSS !== 'undefined' && CSS.supports('display', 'grid');

  //
  // Cell tracking maps
  //

  /**
   * Map of rendered cell indices to their actual DOM elements in the buffer.
   * Rebuilt whenever the buffered set changes, and allows us to avoid making
   * repeated DOM queries in the hot path.
   */
  private cellContainerByIndex = new Map<number, HTMLElement>();

  /**
   * The indices of cells that have been rendered
   */
  private renderedCellIndices = new Set<number>();

  /**
   * The indices of cells that are visible
   */
  private visibleCellIndices = new Set<number>();

  /**
   * The indices of cells that have placeholders in them
   */
  private placeholderCellIndices = new Set<number>();

  //
  // Scroll state and timers
  //

  /** A cache of the scroll container this scroller uses */
  private scrollContainer?: Element;

  private scrollRafId = 0;

  /**
   * Promise tracking an in-flight scroll layout update, so that further
   * calls to `scheduleScrollLayoutUpdate` can be coalesced into a single
   * update. The scroll anchor for that update is captured when the promise
   * starts.
   */
  private pendingScrollLayoutUpdate: Promise<void> | null = null;

  private scrollIdleTimer = 0;

  private scrollToCellInProgress = false;

  private scrollListenersActive = false;

  /**
   * A scroll-anchoring tool to capture/restore the position that cells
   * should maintain while new content renders in, to prevent content from
   * jumping around when placeholder content is replaced and heights change.
   */
  private scrollAnchor = new ScrollAnchor({
    getScrollContainer: () => this.getScrollContainer(),
    getCellContainers: () => this.cellContainers,
    getRenderedCellIndices: () => this.renderedCellIndices,
    isActive: () => this.isVirtualized && !this.scrollToCellInProgress,
  });

  private sentinelIsIntersecting = false;

  /**
   * Set when `scrollThresholdReached` fires; suppresses further events until
   * `itemCount` changes and the resulting render has painted.  This prevents
   * rapid-fire threshold events from the sentinel, while still allowing the
   * event to re-fire after new content has been laid out.
   */
  private sentinelEventPending = false;

  private sentinelIntersectionObserver = new IntersectionObserver(
    this.handleSentinelIntersection.bind(this)
  );

  private cellIntersectionObserver = new IntersectionObserver(
    this.handleCellIntersection.bind(this)
  );

  /**
   * Pending animation frame ID for the next resize-driven recompute.
   * The ResizeObserver callback defers its real work to an rAF so that
   * internal layout mutations this tick don't trigger it; coalescing also
   * means rapid successive resize entries collapse into one recompute.
   */
  private resizeRafId = 0;

  private resizeObserver = new ResizeObserver(this.handleResize.bind(this));

  //
  // Stabilization promise
  //

  private bufferStabilizedResolver?: () => void;

  /**
   * The latest stabilization promise. Always set: initialized in the
   * constructor and re-created by `beginStabilization` when a new
   * stabilization cycle starts. Stays in place (in its resolved state)
   * between cycles, so the `bufferStabilized` getter can return it
   * directly without a fallback.
   */
  private bufferStabilizedPromise!: Promise<void>;

  /**
   * Initializes a new infinite scroller with a `bufferStabilized` promise.
   */
  constructor() {
    super();
    // Eagerly begin buffer stabilization as soon as the component is created,
    // so consumers that immediately read the `bufferStabilized` promise will
    // receive the real pending promise instead of just a temporary
    // already-resolved one.
    this.beginStabilization();
  }

  //
  // Lit lifecycle methods
  //

  connectedCallback() {
    super.connectedCallback?.();
    this.scrollContainer = undefined;
    this.observeSentinel();
    this.setupObservations();
    // On the first mount, `this.container` is not yet in the shadow DOM
    // (firstUpdated handles the initial observation). On re-mount after a
    // disconnect/reconnect cycle, firstUpdated does NOT fire again — so we
    // re-observe here to restore the watch that disconnectedCallback ended.
    if (this.container) this.resizeObserver.observe(this.container);
  }

  disconnectedCallback() {
    this.sentinelIntersectionObserver.disconnect();
    this.cellIntersectionObserver.disconnect();
    this.teardownScrollListener();
    this.resizeObserver?.disconnect();
    this.scrollContainer = undefined;
    this.endStabilization();
    super.disconnectedCallback?.();
  }

  firstUpdated() {
    this.observeSentinel();
    if (this.isVirtualized) {
      this.setupVirtualization();
    }
  }

  willUpdate(changed: PropertyValues) {
    if (changed.has('itemCount')) {
      this.pruneStaleIndices();
      if (this.isVirtualized) {
        this.updateScrollLayout();
        this.syncBufferToScrollPosition();
      }
    }
  }

  updated(changed: PropertyValues) {
    if (
      changed.has('itemCount') ||
      changed.has('scrollOptimizationsDisabled')
    ) {
      if (changed.has('itemCount') && this.isVirtualized) {
        this.scheduleSentinelRecheck();
      }
      this.setupObservations();
    }

    // Refresh the index→DOM cache whenever the buffered cell set could
    // have changed. Buffer mutations are the obvious case; an itemCount
    // change can also shrink virtualBufferIndices (via the clamp
    // `Math.min(bufferEnd, itemCount-1)`) without changing bufferStart/
    // bufferEnd; and toggling scrollOptimizationsDisabled swaps between
    // renderVirtualized and renderAllCells, replacing the DOM elements
    // entirely. Other Lit updates (rowGap, ariaLandmarkLabel, etc.)
    // preserve the keyed repeat output, so the cache remains valid then.
    if (
      this.isVirtualized &&
      (changed.has('bufferStart') ||
        changed.has('bufferEnd') ||
        changed.has('itemCount') ||
        changed.has('scrollOptimizationsDisabled'))
    ) {
      this.refreshCellContainerCache();
    }

    // If virtualization is needed, ensure buffered cells are rendered and re-observed
    // after DOM updates
    if (
      this.isVirtualized &&
      (changed.has('bufferStart') || changed.has('bufferEnd'))
    ) {
      this.processVisibleCells();
      this.setupVirtualizedObservations();
      if (!this.scrollRafId && !this.scrollToCellInProgress) {
        this.scrollRafId = requestAnimationFrame(() => {
          this.scrollRafId = 0;
          this.syncBufferToScrollPosition();
        });
      }
    }
  }

  /** @inheritdoc */
  get bufferStabilized(): Promise<void> {
    return this.bufferStabilizedPromise;
  }

  /**
   * Whether the scroller should use its virtualized mode.
   */
  private get isVirtualized(): boolean {
    return !this.scrollOptimizationsDisabled && this.supportsGrid;
  }

  /**
   * Range of cell indices lying within the current virtualized buffer.
   */
  private get virtualBufferIndices(): number[] {
    if (this.itemCount === 0) return [];
    const start = Math.max(0, this.bufferStart);
    const end = Math.min(this.bufferEnd, this.itemCount - 1);
    if (end < start) return [];
    return generateRange(start, end, 1);
  }

  /**
   * An array of cell indices that need to be rendered based
   * on the currently visible cells and the size of the buffer.
   */
  private get bufferRange(): number[] {
    if (this.isVirtualized) {
      return this.virtualBufferIndices;
    }

    const cellBufferSize = Math.max(10, this.visibleCellIndices.size);

    if (this.visibleCellIndices.size === 0) {
      return generateRange(0, cellBufferSize, 1);
    }

    const minVisibleIndex = Math.min(...this.visibleCellIndices);
    const maxVisibleIndex = Math.max(...this.visibleCellIndices);
    const minBufferIndex = Math.max(minVisibleIndex - cellBufferSize, 0);
    const maxBufferIndex = Math.min(
      maxVisibleIndex + cellBufferSize,
      this.itemCount - 1
    );
    return generateRange(minBufferIndex, maxBufferIndex, 1);
  }

  //
  // Observer setup & handlers
  //

  /**
   * Observe the sentinel for the first time (firstUpdated / connectedCallback).
   * Subsequent re-observations happen only via `scheduleSentinelRecheck`.
   */
  private observeSentinel() {
    if (this.sentinel) this.sentinelIntersectionObserver.observe(this.sentinel);
  }

  /**
   * Re-attach the sentinel observer so it fires its initial callback again
   * with the current intersection state. Used by `reload()` and
   * `scheduleSentinelRecheck()` whenever the layout has changed enough that
   * we want the IO to re-evaluate whether the user is near the end.
   */
  private reobserveSentinel() {
    if (this.sentinel) {
      this.sentinelIntersectionObserver.unobserve(this.sentinel);
      this.sentinelIntersectionObserver.observe(this.sentinel);
    }
  }

  /**
   * After `itemCount` changes, waits for the re-render (with updated
   * spacer height) and one animation frame for paint, then clears the
   * pending flag and re-observes the sentinel so the IO can re-evaluate
   * whether the user is still near the end.
   */
  private scheduleSentinelRecheck(): void {
    this.updateComplete.then(() => {
      requestAnimationFrame(() => {
        this.sentinelEventPending = false;
        this.sentinelIsIntersecting = false;
        this.reobserveSentinel();
      });
    });
  }

  /**
   * Add observations for all of the things that need observing
   */
  private setupObservations() {
    if (this.isVirtualized) {
      this.setupVirtualizedObservations();
    } else {
      this.setupIntersectionObserver();
    }
  }

  private setupVirtualizedObservations() {
    this.cellIntersectionObserver.disconnect();

    // Prune visibleCellIndices to the current buffer range.
    // disconnect() doesn't fire exit callbacks, so indices from a previous
    // buffer would otherwise linger indefinitely
    for (const index of this.visibleCellIndices) {
      if (index < this.bufferStart || index > this.bufferEnd) {
        this.visibleCellIndices.delete(index);
      }
    }

    this.cellContainers.forEach(cell =>
      this.cellIntersectionObserver.observe(cell)
    );

    if (!this.scrollListenersActive) {
      this.setupScrollListener();
    }
  }

  /**
   * The intersection observer is used to determine when cells are visible
   * so we can efficiently render only the minimum number of cells
   */
  private setupIntersectionObserver() {
    this.cellIntersectionObserver.disconnect();

    if (this.scrollOptimizationsDisabled) {
      const indexArray = generateRange(0, Math.max(0, this.itemCount - 1), 1);
      indexArray.forEach(index => this.visibleCellIndices.add(index));
      this.processVisibleCells();
    } else {
      this.cellContainers.forEach(cell =>
        this.cellIntersectionObserver.observe(cell)
      );
    }
  }

  /**
   * IntersectionObserver callback for the sentinel: fires a one-shot
   * `scrollThresholdReached` event when the sentinel becomes visible,
   * and resets the "intersecting" flag when it leaves the viewport
   * so the event can fire again after more content loads.
   */
  private handleSentinelIntersection(
    entries: IntersectionObserverEntry[]
  ): void {
    entries.forEach(entry => {
      if (entry.isIntersecting && !this.sentinelIsIntersecting) {
        this.sentinelIsIntersecting = true;
        if (!this.sentinelEventPending) {
          this.sentinelEventPending = true;
          this.dispatchEvent(new Event('scrollThresholdReached'));
        }
      } else if (!entry.isIntersecting) {
        this.sentinelIsIntersecting = false;
      }
    });
  }

  /**
   * IntersectionObserver callback for the buffered cells: maintains the
   * `visibleCellIndices` set as cells enter/leave the viewport, then
   * dispatches the appropriate downstream work. In virtualized mode, that
   * triggers a visibility change event; otherwise, it immediately reprocesses
   * the buffer.
   */
  private handleCellIntersection(entries: IntersectionObserverEntry[]): void {
    entries.forEach(entry => {
      const cellContainer = entry.target as HTMLDivElement;
      const indexString = cellContainer.dataset.cellIndex;
      if (!indexString) return;
      const index = parseInt(indexString, 10);
      if (entry.isIntersecting) {
        this.visibleCellIndices.add(index);
      } else {
        this.visibleCellIndices.delete(index);
      }
    });

    if (!this.scrollOptimizationsDisabled) {
      if (this.isVirtualized) {
        this.emitVisibleCellsChanged();
      } else {
        this.processVisibleCells();
      }
    }
  }

  /**
   * ResizeObserver callback. Defers its real work to an animation frame so
   * that internal layout mutations this tick don't trigger it, and so that
   * rapid successive resize entries collapse into a single recompute.
   */
  private handleResize(): void {
    if (this.resizeRafId) return;
    this.resizeRafId = requestAnimationFrame(() => {
      this.resizeRafId = 0;
      const newCols = this.getColumnsPerRow();
      if (newCols !== this.cachedColumnsPerRow) {
        this.cachedColumnsPerRow = newCols;
        this.placeholderRowHeight = undefined;
        this.rowHeightCache.recalculateAllRowHeights();
        this.updateScrollLayout();
        this.syncBufferToScrollPosition();
      }
      if (this.rowHeights.size > 0) {
        this.rowHeightCache.recalculateDefaultRowHeight();
      } else {
        this.defaultRowHeight = this.computeDefaultRowHeight();
      }
    });
  }

  //
  // Public API methods
  //

  /** @inheritdoc */
  reload() {
    for (const index of this.renderedCellIndices) {
      this.removeCell(index);
    }

    this.renderedCellIndices.clear();
    this.visibleCellIndices.clear();
    this.placeholderCellIndices.clear();
    this.rowHeightCache.clear();
    this.sentinelEventPending = false;
    this.sentinelIsIntersecting = false;
    this.scrollToCellInProgress = false;
    this.totalContentHeight = 0;
    this.bufferOffsetY = 0;
    this.bufferStart = 0;

    this.bufferEnd = this.computeInitialBufferEnd();

    this.updateScrollLayout();
    this.setupObservations();

    // Re-observe the sentinel so it can fire again with a clean state
    this.reobserveSentinel();

    // Immediately stabilize the buffer
    if (this.isVirtualized) {
      this.stabilizeBuffer();
    }
  }

  /** @inheritdoc */
  refreshCell(index: number): void {
    // In virtualized mode, skip work for cells outside the current buffer.
    // Stale async callbacks (e.g. setTimeout in cellForIndex) can fire for
    // cells the user scrolled past long ago; avoid the querySelector, array
    // allocation, and potential rebuildRowHeights cost for each one.
    if (this.isVirtualized) {
      if (index < this.bufferStart || index > this.bufferEnd) {
        // Just clean up tracking — no DOM element to clear
        this.renderedCellIndices.delete(index);
        this.placeholderCellIndices.delete(index);
        if (this.rowHeightCache.deleteCellHeight(index)) {
          this.rowHeightCache.recalculateAllRowHeights();
          this.scheduleScrollLayoutUpdate();
        }
        return;
      }
      this.scheduleScrollLayoutUpdate();
    }
    this.removeCell(index);
    // In virtualized mode, the early-return above already confirmed `index` is
    // in [bufferStart, bufferEnd]; in non-virtualized mode, fall back to the
    // bufferRange membership check.
    if (this.isVirtualized || this.bufferRange.includes(index)) {
      this.renderCellBuffer([index]);
    }
  }

  /** @inheritdoc */
  refreshAllVisibleCells(): void {
    if (this.isVirtualized) this.scheduleScrollLayoutUpdate();
    const range = this.bufferRange;
    range.forEach(index => this.removeCell(index));
    this.renderCellBuffer(range);
  }

  /** @inheritdoc */
  async scrollToCell(index: number, animated: boolean): Promise<boolean> {
    if (index < 0 || index >= this.itemCount) return false;

    const behavior = animated ? 'smooth' : 'auto';
    if (!this.isVirtualized) {
      const cellContainer = this.cellContainers[index];
      if (!cellContainer) return false;
      cellContainer.scrollIntoView({ behavior });
      return true;
    }

    // We don't want to handle scroll events normally while we're scrolling
    // to a cell, so flag it for now. Stays true until either we fail to find
    // the target cell, or the synchronous scroll completes, or (in the
    // animated case) the smooth scroll settles via scrollend/timeout.
    this.scrollToCellInProgress = true;

    // Cancel any pending scroll-driven work, since we're overriding it.
    if (this.scrollRafId) {
      cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = 0;
    }
    if (this.scrollIdleTimer) {
      clearTimeout(this.scrollIdleTimer);
      this.scrollIdleTimer = 0;
    }

    this.snapBufferToCell(index);

    // First we render cells for the buffer range and fill them with content.
    // Then on the next animation frame we measure their real heights and
    // recompute the scroll-layout values so we can scroll the targeted cell
    // into view accurately.
    await this.updateComplete;
    await new Promise(r => requestAnimationFrame(r));
    this.measureBufferedCells();
    this.updateScrollLayout();
    this.requestUpdate();
    await this.updateComplete;

    const targetCell = this.cellContainerForIndex(index);
    if (!targetCell) {
      this.scrollToCellInProgress = false;
      return false;
    }
    targetCell.scrollIntoView({ behavior });

    if (!animated) {
      // Synchronous scroll has already completed.
      this.scrollToCellInProgress = false;
      return true;
    }

    // Smooth scroll: keep scrollToCellInProgress=true until the animation
    // settles. Otherwise handleScroll would fire during the animation,
    // trigger syncBufferToScrollPosition, and the buffer shift's scroll
    // anchoring would call scrollBy. That would cancel the in-flight smooth
    // scroll and strand the user well short of the target.
    await this.nextSmoothScrollEnd();
    this.scrollToCellInProgress = false;
    return true;
  }

  /** @inheritdoc */
  getVisibleCellIndices(): number[] {
    return Array.from(this.visibleCellIndices);
  }

  /**
   * Prunes any obsolete indices from the visible/rendered/placeholder sets that
   * lie outside the range defined by the current itemCount.
   */
  private pruneStaleIndices() {
    for (const index of this.visibleCellIndices) {
      if (index >= this.itemCount) this.visibleCellIndices.delete(index);
    }
    for (const index of this.renderedCellIndices) {
      if (index >= this.itemCount) this.renderedCellIndices.delete(index);
    }
    for (const index of this.placeholderCellIndices) {
      if (index >= this.itemCount) this.placeholderCellIndices.delete(index);
    }
    this.rowHeightCache.pruneAtOrAbove(this.itemCount);
    this.rowHeightCache.recalculateAllRowHeights();
  }

  /**
   * Snap `bufferStart`/`bufferEnd` to the row containing `index`, with a
   * margin of `bufferRows` rows on each side. Used by `scrollToCell`
   * as the initial buffer setup, before any of the target's cells have
   * been rendered or measured (following up with accurate measurements
   * once the DOM updates).
   *
   * The bounds must be snapped to row boundaries (multiples of `cols`):
   * otherwise the CSS grid lays the buffered cells out starting from
   * column 0 instead of from the target cell's true column, producing a
   * visual misalignment that the next `syncBufferToScrollPosition` would
   * then correct with a visible jump.
   */
  private snapBufferToCell(index: number): void {
    const container = this.getScrollContainer();
    const viewportHeight = isDocumentScroller(container)
      ? window.innerHeight
      : container.clientHeight;
    const cols = this.cachedColumnsPerRow;
    const visibleRows = Math.ceil(viewportHeight / this.defaultRowHeight);
    const minBufferRows = Math.ceil(this.minBufferSize / cols);
    const proportionalRows = Math.ceil(visibleRows * this.bufferMultiplier);
    const bufferRows = Math.max(minBufferRows, proportionalRows);

    const targetRow = Math.floor(index / cols);
    const totalRows = this.getTotalRows();
    const startRow = Math.max(0, targetRow - bufferRows);
    const endRow = Math.min(totalRows - 1, targetRow + bufferRows);
    this.bufferStart = startRow * cols;
    this.bufferEnd = Math.min(this.itemCount - 1, (endRow + 1) * cols - 1);
    this.updateScrollLayout();
  }

  /**
   * Resolves when the next smooth-scroll animation settles. Listens for
   * the native `scrollend` event (preferred) and falls back to a 2s
   * timeout for browsers that don't fire it (older Firefox/Safari).
   * The fallback timeout is also a safety net for very long animations:
   * if the actual scroll runs longer than 2s, the buffer will resume
   * normal updates a bit early but the animation itself isn't disrupted.
   *
   * One-shot — resolves on the next scrollend (or timeout) and then
   * detaches. Callers needing to await another smooth-scroll cycle must
   * call this again to register a fresh listener.
   */
  private nextSmoothScrollEnd(): Promise<void> {
    return new Promise(resolve => {
      const scrollContainer = this.getScrollContainer();
      const eventTarget: EventTarget = isDocumentScroller(scrollContainer)
        ? window
        : scrollContainer;
      let fallbackId = 0;
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        eventTarget.removeEventListener('scrollend', cleanup);
        if (fallbackId) window.clearTimeout(fallbackId);
        resolve();
      };
      eventTarget.addEventListener('scrollend', cleanup, { once: true });
      fallbackId = window.setTimeout(cleanup, 2000);
    });
  }

  //
  // Virtualization setup & stabilization
  //

  /**
   * Initial setup needed for virtualized rendering of cells
   */
  private setupVirtualization(): void {
    this.cachedColumnsPerRow = this.getColumnsPerRow();
    this.rowGap = this.getRowGap();
    this.defaultRowHeight = this.computeDefaultRowHeight();

    // Start with a modest initial buffer; it will be refined after first paint
    this.bufferStart = 0;
    this.bufferEnd = this.computeInitialBufferEnd();
    this.updateScrollLayout();

    this.setupScrollListener();

    // First-mount observation of the container for layout changes (column
    // count, host resize, etc.). The ResizeObserver itself is a field
    // initializer; re-observation after a disconnect/reconnect cycle is
    // handled by connectedCallback.
    if (this.container) this.resizeObserver.observe(this.container);

    this.stabilizeBuffer();
  }

  /**
   * Asynchronously attempts to stabilize the buffered range of cells.
   * Waits a frame after cells paint, measures real row heights, recomputes
   * the buffer, and finally resolves the `bufferStabilized` promise.
   */
  private async stabilizeBuffer(): Promise<void> {
    this.beginStabilization();
    await this.updateComplete;

    this.refreshCellContainerCache();
    this.processVisibleCells();

    // After child components paint, measure real heights and (if needed) recompute
    // the buffer to fill the viewport accurately.
    requestAnimationFrame(() => {
      this.measureBufferedCells();
      this.rowHeightCache.recalculateDefaultRowHeight();
      this.syncBufferToScrollPosition();
      this.updateComplete.then(() => {
        this.endStabilization();
      });
    });
  }

  /** Sets up the bufferStabilized promise for callers to await */
  private beginStabilization(): void {
    if (!this.bufferStabilizedResolver) {
      this.bufferStabilizedPromise = new Promise(resolve => {
        this.bufferStabilizedResolver = resolve;
      });
    }
  }

  /** Resolves the bufferStabilized promise and emits a corresponding event */
  private endStabilization(): void {
    if (!this.bufferStabilizedResolver) return;
    this.bufferStabilizedResolver();
    this.bufferStabilizedResolver = undefined;
    this.dispatchEvent(new Event('bufferStabilized'));
  }

  //
  // Scroll listener setup & teardown
  //

  private setupScrollListener(): void {
    this.teardownScrollListener();
    const container = this.getScrollContainer();
    const target = isDocumentScroller(container) ? window : container;
    target.addEventListener('scroll', this.handleScroll, { passive: true });
    this.scrollListenersActive = true;
  }

  private teardownScrollListener(): void {
    if (!this.scrollListenersActive) return;
    if (this.scrollContainer) {
      const target = isDocumentScroller(this.scrollContainer)
        ? window
        : this.scrollContainer;
      target.removeEventListener('scroll', this.handleScroll);
    }

    if (this.scrollRafId) {
      cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = 0;
    }
    if (this.scrollIdleTimer) {
      clearTimeout(this.scrollIdleTimer);
      this.scrollIdleTimer = 0;
    }
    this.scrollListenersActive = false;
  }

  //
  // Scroll layout & geometry helpers
  //

  /**
   * Returns how many columns each row of the scroller grid currently contains, if
   * using CSS grid (or 1 if not).
   */
  private getColumnsPerRow(): number {
    if (!this.container) return 1;
    const cols = getComputedStyle(this.container).gridTemplateColumns;
    return cols.split(' ').filter(s => s.length > 0).length || 1;
  }

  /**
   * Returns the row-gap style applied to the scroll container, in pixels.
   */
  private getRowGap(): number {
    if (!this.container) return 0;
    return parseFloat(getComputedStyle(this.container).rowGap) || 0;
  }

  /**
   * Returns the total number of rows the current item count could produce, given
   * the current number of columns.
   */
  private getTotalRows(): number {
    return Math.ceil(this.itemCount / this.cachedColumnsPerRow);
  }

  /**
   * Computes the initial `bufferEnd` value used by `reload()` and
   * `setupVirtualization()` when the buffer starts at index 0 (i.e. before
   * any user scrolling). Generously over-allocates compared to the
   * per-shift formula in `syncBufferToScrollPosition` because we don't yet
   * know real row heights; the buffer is refined after first paint via
   * `stabilizeBuffer()`.
   */
  private computeInitialBufferEnd(): number {
    const estimatedVisibleRows = Math.ceil(
      window.innerHeight / this.defaultRowHeight
    );
    const minBuffer = this.minBufferSize * 2;
    const proportionalBuffer =
      estimatedVisibleRows *
      (1 + this.bufferMultiplier * 2) *
      this.cachedColumnsPerRow;
    return Math.min(
      Math.max(minBuffer, proportionalBuffer),
      this.itemCount - 1
    );
  }

  private computeDefaultRowHeight(): number {
    if (this.estimatedCellHeight != null) return this.estimatedCellHeight;
    if (!this.container) return INITIAL_ROW_HEIGHT;
    const temp = document.createElement('div');
    temp.style.height = 'var(--infiniteScrollerCellMinHeight, 22.5rem)';
    this.container.appendChild(temp);
    const height = temp.offsetHeight;
    temp.remove();
    return height || INITIAL_ROW_HEIGHT;
  }

  /**
   * Finds and returns the nearest scrolling container in this component's
   * ancestry, caching the result. The cache is cleared in
   * `disconnectedCallback`/`connectedCallback` because the DOM ancestor
   * chain may differ across attachments.
   */
  private getScrollContainer(): Element {
    if (this.scrollContainer) return this.scrollContainer;
    this.scrollContainer = findScrollContainer(this);
    return this.scrollContainer;
  }

  /**
   * Recompute the two derived scroll-layout values that depend on the
   * current per-row height estimates:
   *  - `totalContentHeight`: the height the scroll spacer needs to be
   *    so the document can scroll across the entire virtual content,
   *    including the unrendered rows above and below the buffer.
   *  - `bufferOffsetY`: the Y offset (via CSS transform) at which the
   *    rendered buffer is positioned within that virtual space, so it
   *    visually occupies the rows the user has scrolled the viewport to.
   *
   * Called after `rowHeights` changes; e.g. after `measureBufferedCells`
   * records new heights, or after a buffer shift adopts/forgets rows.
   * Cheap (one pass over the rows); safe to call frequently.
   */
  private updateScrollLayout(): void {
    const totalRows = this.getTotalRows();
    if (totalRows === 0) {
      this.totalContentHeight = 0;
      this.bufferOffsetY = 0;
      return;
    }
    const { rowGap } = this;
    this.totalContentHeight = this.rowHeightCache.sumRowHeights(
      0,
      totalRows - 1,
      rowGap
    );
    const bufferStartRow = Math.floor(
      this.bufferStart / this.cachedColumnsPerRow
    );
    // sumRowHeights(0, k-1) returns sum(heights) + (k-1) * rowGap.
    // Row k's top edge is at sum(heights) + k*rowGap, so add one rowGap.
    this.bufferOffsetY =
      bufferStartRow > 0
        ? this.rowHeightCache.sumRowHeights(0, bufferStartRow - 1, rowGap) +
          rowGap
        : 0;
  }

  /**
   * Event handler for passive scroll events, throttled to minimize unnecessary updates.
   */
  private handleScroll = (): void => {
    if (this.scrollToCellInProgress) return;
    // We just adjusted scrollTop for scroll anchoring; ignore the
    // resulting event so the recompute doesn't reverse our compensation.
    if (this.scrollAnchor.shouldSuppressNextScrollEvent()) return;
    if (!this.scrollRafId) {
      this.scrollRafId = requestAnimationFrame(() => {
        this.scrollRafId = 0;
        this.syncBufferToScrollPosition();
      });
    }
    // Fire the idle handling only once, after scrolling stops
    if (this.scrollIdleTimer) clearTimeout(this.scrollIdleTimer);
    this.scrollIdleTimer = window.setTimeout(() => {
      this.scrollIdleTimer = 0;
      this.syncBufferToScrollPosition();
    }, 150);
  };

  /**
   * Schedule a coalesced scroll-layout update: re-measure buffered cell
   * heights, recompute the spacer & buffer size/positioning, and re-anchor
   * the visible scroll position. Called after any DOM mutation that could
   * change in-buffer row heights.
   *
   * If an update is already pending, this call will be a no-op.
   *
   * We deliberately do not call `syncBufferToScrollPosition` here, which could
   * shift bufferStart/bufferEnd and remove the very cell whose refresh just
   * triggered the update. Only the scroll-layout values are recomputed; the
   * buffer window stays fixed.
   */
  private scheduleScrollLayoutUpdate(): void {
    if (this.pendingScrollLayoutUpdate) return;
    const anchor = this.scrollAnchor.capture();
    this.pendingScrollLayoutUpdate = this.runScrollLayoutUpdate(anchor);
  }

  /**
   * The async body for a scheduled scroll-layout update. Holds the
   * pre-mutation `anchor` in closure scope across an animation frame,
   * then re-measures, recomputes layout, and restores the anchor once
   * Lit has rendered (when geometry changed) or immediately otherwise.
   *
   * The finally block ensures `pendingScrollLayoutUpdate` is cleared
   * regardless of errors, so the next batch can start.
   */
  private async runScrollLayoutUpdate(
    anchor: ScrollAnchorPoint | null
  ): Promise<void> {
    try {
      await new Promise(r => requestAnimationFrame(r));
      const prevTotal = this.totalContentHeight;
      const prevOffset = this.bufferOffsetY;
      this.measureBufferedCells();
      this.updateScrollLayout();
      if (
        prevTotal !== this.totalContentHeight ||
        prevOffset !== this.bufferOffsetY
      ) {
        this.requestUpdate();
        await this.updateComplete;
      }
      // Geometry didn't change but in-buffer row heights might still have
      // (the spacer total and bufferOffsetY can stay constant while
      // individual row heights inside the buffer change). Re-anchor either way.
      this.scrollAnchor.restore(anchor);
    } finally {
      this.pendingScrollLayoutUpdate = null;
    }
  }

  private measureBufferedCells(): void {
    for (const cell of this.cellContainers) {
      const indexStr = cell.dataset.cellIndex;
      if (indexStr) {
        const index = parseInt(indexStr, 10);
        if (this.renderedCellIndices.has(index) && cell.offsetHeight > 0) {
          this.rowHeightCache.recordCellHeight(index, cell.offsetHeight);
        }
      }
    }

    this.updatePlaceholderRowHeight();
  }

  /**
   * Estimates the typical placeholder row height by averaging the offsetHeight
   * of placeholders that lie in **placeholder-only rows** (rows containing no
   * rendered/measured siblings). Mixed rows inflate placeholder cells to the
   * row's max, which biases a single-sample capture. By restricting to
   * placeholder-only rows we get a clean signal of the placeholder's intrinsic
   * height; if no placeholder-only rows are currently buffered we keep the
   * previous estimate rather than overwriting it with an inflated value.
   */
  private updatePlaceholderRowHeight(): void {
    if (this.placeholderCellIndices.size === 0) return;

    const rowToPlaceholders = this.groupPlaceholdersByRow();
    let sum = 0;
    let count = 0;
    for (const [row, indices] of rowToPlaceholders) {
      if (this.isPlaceholderOnlyRow(row)) {
        for (const idx of indices) {
          const cell = this.cellContainerForIndex(idx);
          if (cell && cell.offsetHeight > 0) {
            sum += cell.offsetHeight;
            count += 1;
          }
        }
      }
    }
    if (count > 0) {
      this.placeholderRowHeight = sum / count;
    }
    // If no placeholder-only rows are currently buffered, keep the previous
    // estimate rather than overwriting with an inflated mixed-row value.
  }

  /**
   * Groups the currently-buffered placeholder cell indices by the row they
   * belong to, for use by `updatePlaceholderRowHeight`.
   */
  private groupPlaceholdersByRow(): Map<number, number[]> {
    const cols = this.cachedColumnsPerRow;
    const rowToPlaceholders = new Map<number, number[]>();
    for (const idx of this.placeholderCellIndices) {
      const row = Math.floor(idx / cols);
      const existing = rowToPlaceholders.get(row);
      if (existing) existing.push(idx);
      else rowToPlaceholders.set(row, [idx]);
    }
    return rowToPlaceholders;
  }

  /**
   * Returns true if `row` contains only placeholder cells (no
   * currently-rendered content cells). Placeholder-height sampling must
   * restrict to such rows because CSS grid inflates the placeholder cells
   * in mixed rows to match the row's rendered siblings, masking their
   * intrinsic height.
   *
   * We deliberately check `renderedCellIndices` rather than `cellHeights`.
   * The latter persists across buffer shifts (so cells the user scrolled
   * past long ago still appear as "measured"), but the row's *current*
   * render only depends on cells presently in the buffer as content. Using
   * `cellHeights.has` here would mark almost every row as mixed after even
   * modest scrolling, leaving the placeholder estimate permanently
   * unupdated.
   */
  private isPlaceholderOnlyRow(row: number): boolean {
    const cols = this.cachedColumnsPerRow;
    const firstCellInRow = row * cols;
    for (let c = 0; c < cols; c += 1) {
      if (this.renderedCellIndices.has(firstCellInRow + c)) {
        return false;
      }
    }
    return true;
  }

  private syncBufferToScrollPosition(): void {
    // Re-measure heights of buffered cells, since child components may have
    // rendered since the cells were created
    this.measureBufferedCells();

    if (!this.container) return;
    const totalRows = this.getTotalRows();
    if (totalRows === 0) return;

    const viewport = this.getContentRelativeViewport();
    const { firstVisibleRow, lastVisibleRow } = this.findVisibleRowRange(
      viewport.relativeScrollTop,
      viewport.relativeScrollBottom,
      totalRows
    );
    if (this.bufferHasSufficientMargin(firstVisibleRow, lastVisibleRow)) return;

    const { newStart, newEnd } = this.computeBufferBounds(
      firstVisibleRow,
      lastVisibleRow,
      totalRows,
      viewport.viewportHeight
    );
    if (newStart === this.bufferStart && newEnd === this.bufferEnd) return;

    // Capture the visible anchor before mutating bufferStart/bufferEnd. The
    // buffer shift typically changes bufferOffsetY by a different amount
    // than the user's scrollTop just changed (e.g., when newly-absorbed
    // rows have stale content-sized rowHeights from prior browsing), which
    // would otherwise yank the visible content forward or backward.
    const anchor = this.scrollAnchor.capture();

    // Update the default-row-height estimate to track the average of the
    // currently-measured rows. We intentionally do NOT clear placeholder row
    // heights here even when the current buffer has no placeholders, because
    // there may still be placeholders elsewhere in the full span of cells.
    // Clearing it can cause the buffer offset to oscillate between a
    // placeholderRowHeight-based estimate and a defaultRowHeight-based one
    // as the user scrolls through mixed regions, producing visible jumping.
    // The placeholder estimate is reset only on reload() or a column-count
    // change.
    if (this.rowHeights.size > 0) {
      this.rowHeightCache.recalculateDefaultRowHeight();
    }
    this.bufferStart = newStart;
    this.bufferEnd = newEnd;
    this.updateScrollLayout();
    // Lit needs to re-render with the new buffer + transform before
    // bounding-rect calls will reflect the new layout.
    this.updateComplete.then(() => this.scrollAnchor.restore(anchor));
  }

  /**
   * Computes the current viewport's location within the scroller's content
   * area, accounting for whether the scroller is the document or a nested
   * overflow container. Returns the viewport's top/bottom expressed as
   * pixel offsets _within the scroller content_ (where 0 represents the top
   * of the scroller itself). The container element must exist, or this method
   * will throw.
   */
  private getContentRelativeViewport(): {
    relativeScrollTop: number;
    relativeScrollBottom: number;
    viewportHeight: number;
  } {
    const scrollContainer = this.getScrollContainer();
    const scrollTop = isDocumentScroller(scrollContainer)
      ? window.scrollY
      : scrollContainer.scrollTop;
    const viewportHeight = isDocumentScroller(scrollContainer)
      ? window.innerHeight
      : scrollContainer.clientHeight;

    const rectElement = this.scrollSpacer ?? this.container!;
    const spacerRect = rectElement.getBoundingClientRect();
    const containerTopInScroller = isDocumentScroller(scrollContainer)
      ? spacerRect.top + window.scrollY
      : spacerRect.top +
        scrollContainer.scrollTop -
        scrollContainer.getBoundingClientRect().top;

    const relativeScrollTop = scrollTop - containerTopInScroller;
    return {
      relativeScrollTop,
      relativeScrollBottom: relativeScrollTop + viewportHeight,
      viewportHeight,
    };
  }

  /**
   * Walks row heights to find the first and last rows currently visible
   * within the viewport range `[relativeScrollTop, relativeScrollBottom)`.
   * Uses the row height cache to acquire estimates/measurements of rows.
   */
  private findVisibleRowRange(
    relativeScrollTop: number,
    relativeScrollBottom: number,
    totalRows: number
  ): { firstVisibleRow: number; lastVisibleRow: number } {
    const { rowGap } = this;
    let heightSoFar = 0;
    let firstVisibleRow = 0;
    let lastVisibleRow = totalRows - 1;
    let foundFirst = false;

    for (let r = 0; r < totalRows; r += 1) {
      const rowHeight = this.rowHeightCache.rowHeightFor(r);
      const rowTop = heightSoFar;
      const rowBottom = heightSoFar + rowHeight;

      if (!foundFirst && rowBottom > relativeScrollTop) {
        firstVisibleRow = r;
        foundFirst = true;
      }
      if (foundFirst && rowTop >= relativeScrollBottom) {
        lastVisibleRow = r - 1;
        break;
      }

      heightSoFar += rowHeight + rowGap;
    }

    return { firstVisibleRow, lastVisibleRow };
  }

  /**
   * Returns true if the current buffer is comfortably larger than the visible
   * range. Specifically, at least `minMargin` rows of headroom must exist on
   * each side. When the buffer has sufficient margin, we deliberately skip
   * recomputing buffer bounds to avoid jittering back and forth on every
   * scroll tick.
   */
  private bufferHasSufficientMargin(
    firstVisibleRow: number,
    lastVisibleRow: number
  ): boolean {
    const cols = this.cachedColumnsPerRow;
    const minBufferRows = Math.ceil(this.minBufferSize / cols);
    const numVisibleRows = lastVisibleRow - firstVisibleRow + 1;
    const proportionalRows = Math.ceil(numVisibleRows * this.bufferMultiplier);
    const bufferRows = Math.max(minBufferRows, proportionalRows);

    const currentStartRow = Math.floor(this.bufferStart / cols);
    const currentEndRow = Math.floor(
      Math.min(this.bufferEnd, this.itemCount - 1) / cols
    );
    const minMargin = Math.max(2, Math.floor(bufferRows / 3));
    return (
      firstVisibleRow >= currentStartRow + minMargin &&
      lastVisibleRow <= currentEndRow - minMargin
    );
  }

  /**
   * Computes where the rendered buffer should sit given the current
   * visible row range, returning the new buffer's start and end cell indices.
   *
   * The buffer is extended past the visible rows by whichever is larger:
   * the cell-count-based floor from `minBufferSize`, or an extension proportional
   * to the viewportHeight (controlled by bufferMultiplier).
   */
  private computeBufferBounds(
    firstVisibleRow: number,
    lastVisibleRow: number,
    totalRows: number,
    viewportHeight: number
  ): { newStart: number; newEnd: number } {
    const cols = this.cachedColumnsPerRow;
    const { rowGap } = this;
    const minBufferRows = Math.ceil(this.minBufferSize / cols);

    // Walk outward from the visible range in px to size the buffer, since
    // placeholder rows can be very different sizes from fully-rendered ones
    // (using row count alone would leave blank gaps in mixed-load regions).
    const minBufferPx = viewportHeight * Math.max(1, this.bufferMultiplier);

    let newStartRow = firstVisibleRow;
    let startPx = 0;
    while (newStartRow > 0 && startPx < minBufferPx) {
      newStartRow -= 1;
      startPx += this.rowHeightCache.rowHeightFor(newStartRow) + rowGap;
    }

    let newEndRow = lastVisibleRow;
    let endPx = 0;
    while (newEndRow < totalRows - 1 && endPx < minBufferPx) {
      newEndRow += 1;
      endPx += this.rowHeightCache.rowHeightFor(newEndRow) + rowGap;
    }

    // Apply count-based floor from minBufferSize
    newStartRow = Math.min(
      newStartRow,
      Math.max(0, firstVisibleRow - minBufferRows)
    );
    newEndRow = Math.max(
      newEndRow,
      Math.min(totalRows - 1, lastVisibleRow + minBufferRows)
    );

    return {
      newStart: newStartRow * cols,
      newEnd: Math.min((newEndRow + 1) * cols - 1, this.itemCount - 1),
    };
  }

  //
  // Lit rendering & cell buffer operations
  //

  render(): TemplateResult {
    if (this.isVirtualized) {
      return this.renderVirtualized();
    }
    // For SSR, we may need to render a set of cells immediately without virtualization
    return this.renderAllCells();
  }

  /**
   * Renders a virtualized buffer of cells for the current viewport, surrounded by a scroll
   * spacer that maintains the full scrollable height of the unbuffered regions.
   */
  private renderVirtualized(): TemplateResult {
    const bufferIndices = this.virtualBufferIndices;
    const containerAriaLabel = this.ariaLandmarkLabel ?? nothing;
    return html`
      <div id="scroll-spacer" style="height:${this.totalContentHeight}px">
        <div id="sentinel" aria-hidden="true"></div>
        <section
          id="container"
          role="feed"
          aria-label=${containerAriaLabel}
          style="transform:translateY(${this.bufferOffsetY}px)"
          @transitionend=${this.handleContainerTransition}
        >
          ${repeat(
            bufferIndices,
            index => index,
            index => html`
              <article
                class="cell-container"
                aria-posinset=${index + 1}
                aria-setsize=${this.itemCount}
                data-cell-index=${index}
                @click=${(e: Event) => this.cellSelected(e, index)}
                @keyup=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') this.cellSelected(e, index);
                }}
              ></article>
            `
          )}
          ${this.bufferEnd >= this.itemCount - 1
            ? html`<slot name="result-last-tile"></slot>`
            : nothing}
        </section>
      </div>
    `;
  }

  /**
   * Renders the full set of cells and their contents, without any virtualization
   */
  private renderAllCells(): TemplateResult {
    const finalIndex = this.itemCount - 1;
    const indexArray = generateRange(0, finalIndex, 1);
    const containerAriaLabel = this.ariaLandmarkLabel ?? nothing;
    return html`
      <section id="container" role="feed" aria-label=${containerAriaLabel}>
        <div id="sentinel" aria-hidden="true"></div>
        ${repeat(
          indexArray,
          index => index,
          index => html`
            <article
              class="cell-container"
              aria-posinset=${index + 1}
              aria-setsize=${this.itemCount}
              data-cell-index=${index}
              @click=${(e: Event) => this.cellSelected(e, index)}
              @keyup=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') this.cellSelected(e, index);
              }}
            ></article>
          `
        )}
        <slot name="result-last-tile"></slot>
      </section>
    `;
  }

  /**
   * Handler to update the cached row-gap value whenever it changes
   * (making use of the transitionend event).
   */
  private handleContainerTransition(e: TransitionEvent): void {
    if (e.propertyName === 'row-gap') {
      this.rowGap = this.getRowGap();
      this.updateScrollLayout();
    }
  }

  /**
   * After we processes all of the currently viewable cells, we want to update
   * the buffer on either side to help with scroll performance.
   */
  private processVisibleCells() {
    const { bufferRange } = this;
    this.renderCellBuffer(bufferRange);
    this.removeCellsOutsideBufferRange(bufferRange);
    this.emitVisibleCellsChanged();
  }

  private emitVisibleCellsChanged() {
    this.dispatchEvent(
      new CustomEvent('visibleCellsChanged', {
        detail: {
          visibleCellIndices: Array.from(this.visibleCellIndices),
        },
      })
    );
  }

  /**
   * Handler to emit an event whenever a cell is clicked
   */
  private cellSelected(e: Event, index: number) {
    const event = new CustomEvent<CellSelectionDetails>('cellSelected', {
      detail: {
        index,
        originalEvent: e,
      },
    });
    this.dispatchEvent(event);
  }

  /**
   * Render cells in the given buffer range
   */
  private renderCellBuffer(bufferRange: number[]) {
    bufferRange.forEach(index => {
      if (this.renderedCellIndices.has(index)) return;
      const cellContainer = this.cellContainerForIndex(index);
      if (!cellContainer) return;
      const template = this.cellProvider?.cellForIndex(index);
      if (template) {
        render(template, cellContainer);
        this.renderedCellIndices.add(index);
        this.placeholderCellIndices.delete(index);
      } else {
        if (this.placeholderCellIndices.has(index)) return;
        render(this.placeholderCellTemplate, cellContainer);
        this.placeholderCellIndices.add(index);
        // If this cell had a leftover cellHeights entry from a previous
        // content rendering (e.g., the user scrolled away from a measured
        // content cell and is now revisiting it with placeholders enabled),
        // clear it so the row's height estimate reflects what is actually
        // rendering now (a placeholder) instead of the stale content
        // measurement, which would otherwise inflate the scroll spacer
        // and buffer offset.
        if (this.rowHeightCache.deleteCellHeight(index)) {
          this.rowHeightCache.recalculateRowHeight(
            Math.floor(index / this.cachedColumnsPerRow)
          );
        }
      }
    });
  }

  /**
   * Remove cells from the DOM that are outside of the buffer range
   */
  private removeCellsOutsideBufferRange(bufferRange: number[]) {
    const bufferSet = new Set(bufferRange);
    const renderedUnbufferedCells = Array.from(this.renderedCellIndices).filter(
      index => !bufferSet.has(index)
    );

    renderedUnbufferedCells.forEach(index => {
      const cellContainer = this.cellContainerForIndex(index);
      if (cellContainer) {
        render(nothing, cellContainer);
      }
      this.renderedCellIndices.delete(index);
      this.placeholderCellIndices.delete(index);
    });

    // Also clear placeholder tracking for cells no longer in the buffer.
    // Without this, fast scrolling can leave stale entries that cause
    // renderCellBuffer to skip re-rendering placeholders for new DOM elements.
    for (const index of this.placeholderCellIndices) {
      if (!bufferSet.has(index)) this.placeholderCellIndices.delete(index);
    }
  }

  private removeCell(index: number) {
    // The DOM element may have already been torn down (e.g. by a template
    // re-render in virtualized mode); in that case there's nothing to clear
    // visually, but the tracking sets still need cleanup.
    const cellContainer = this.cellContainerForIndex(index);
    if (cellContainer) {
      render(nothing, cellContainer);
    }
    this.renderedCellIndices.delete(index);
    this.placeholderCellIndices.delete(index);
    if (this.rowHeightCache.deleteCellHeight(index)) {
      this.rowHeightCache.recalculateAllRowHeights();
    }
  }

  private cellContainerForIndex(index: number): HTMLElement | null {
    if (!this.isVirtualized) {
      return this.cellContainers[index] ?? null;
    }
    // Cache populated by refreshCellContainerCache() on every render where
    // the buffered cell set changes; lookup is O(1) here instead of a
    // shadow-DOM querySelector per call.
    return this.cellContainerByIndex.get(index) ?? null;
  }

  /**
   * Rebuilds `cellContainerByIndex` from the current `.cell-container` DOM
   * elements. Call from `updated()` whenever the buffer's set of rendered
   * cells has changed (bufferStart or bufferEnd mutation). Other state
   * changes don't add/remove cells from the DOM, so the cache remains
   * valid until the next buffer shift.
   */
  private refreshCellContainerCache(): void {
    this.cellContainerByIndex.clear();
    const cells = this.cellContainers;
    for (const cell of cells) {
      const idxStr = cell.dataset.cellIndex;
      if (idxStr !== undefined) {
        this.cellContainerByIndex.set(Number(idxStr), cell);
      }
    }
  }

  //
  // Styles
  //

  static get styles(): CSSResultGroup {
    const sentinelHeightCss = css`var(--infiniteScrollerSentinelDistanceFromEnd, 200rem)`;
    const rowGapSizeCss = css`var(--infiniteScrollerRowGap, 1.7rem)`;
    const colGapSizeCss = css`var(--infiniteScrollerColGap, 1.7rem)`;
    const cellMinWidth = css`var(--infiniteScrollerCellMinWidth, 16rem)`;
    const cellMaxWidth = css`var(--infiniteScrollerCellMaxWidth, 1fr)`;
    const cellMinHeight = css`var(--infiniteScrollerCellMinHeight, 22.5rem)`;
    const cellMaxHeight = css`var(--infiniteScrollerCellMaxHeight, none)`;
    const cellOutline = css`var(--infiniteScrollerCellOutline, 0)`;

    return css`
      #container {
        position: relative;
        display: flex;
        flex-wrap: wrap;
        grid-row-gap: ${rowGapSizeCss};
        row-gap: ${rowGapSizeCss};
        grid-column-gap: ${colGapSizeCss};
        column-gap: ${colGapSizeCss};

        /* This transition allows us to listen for changes to the row-gap */
        transition: row-gap 1ms linear;
      }

      @supports (display: grid) {
        #container {
          display: grid;
          flex-wrap: nowrap;
          grid-template-columns: repeat(
            auto-fill,
            minmax(${cellMinWidth}, ${cellMaxWidth})
          );
        }
      }

      .cell-container {
        outline: ${cellOutline};
        min-height: ${cellMinHeight};
        max-height: ${cellMaxHeight};
        min-width: ${cellMinWidth};
        max-width: ${cellMaxWidth};
      }

      @supports (display: grid) {
        /* the grid takes care of the width */
        .cell-container {
          min-width: auto;
          max-width: none;
        }
      }

      #scroll-spacer {
        position: relative;
      }

      #sentinel {
        position: absolute;
        height: ${sentinelHeightCss};
        bottom: 0;
        left: 0;
        right: 0;
        z-index: -1;
        /**
        Chrome and Firefox try to maintain scroll position when the page increases and
        decreases in size, but the scroll position is being focused on the sentinel
        so it's causing the "load more" event to keep firing because it thinks the
        user has scrolled to the sentinel. "overflow-anchor: none" prevents that anchoring
        */
        overflow-anchor: none;
      }
    `;
  }
}
