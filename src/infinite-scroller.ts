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
import { generateRange } from './range-generator';

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
 * A value to initially size rows before anything is known about their
 * actual heights.
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
   * Map of rendered cell indices to their actual DOM elements in the buffer.
   * Rebuilt whenever the buffered set changes, and allows us to avoid making
   * repeated DOM queries in the hot path.
   */
  private cellContainerByIndex = new Map<number, HTMLDivElement>();

  private cachedColumnsPerRow = 1;

  private defaultRowHeight = INITIAL_ROW_HEIGHT;

  private cellHeights = new Map<number, number>();

  private rowHeights = new Map<number, number>();

  private placeholderRowHeight: number | undefined;

  private totalContentHeight = 0;

  private bufferOffsetY = 0;

  private supportsGrid =
    typeof CSS !== 'undefined' && CSS.supports('display', 'grid');

  private resizeObserver?: ResizeObserver;

  private scrollContainer?: Element;

  private scrollRafId = 0;

  /**
   * Pending rAF id for the next scroll-layout update — the cycle that
   * re-measures buffered cell heights, recomputes `totalContentHeight` and
   * `bufferOffsetY`, and re-anchors the scroll position. Tracked so that
   * many calls to `scheduleScrollLayoutUpdate` in the same tick coalesce
   * into a single rAF, and so the update can be cancelled on teardown.
   */
  private scrollLayoutRafId = 0;

  private scrollIdleTimer = 0;

  private scrollToCellInProgress = false;

  private scrollListenersActive = false;

  /**
   * Flag to ignore a single scroll event during scroll anchoring, avoiding
   * a recursive loop where restoring the anchor itself causes the buffer
   * to oscillate between different states.
   */
  private suppressScrollHandlerOnce = false;

  /**
   * Scroll anchor captured synchronously by refreshCell /
   * refreshAllVisibleCells BEFORE they mutate the DOM, for the next
   * `scheduleScrollLayoutUpdate` rAF to consume.
   *
   * Capturing inside the rAF instead would observe post-mutation
   * positions: `renderCellBuffer` already added the refreshed indices
   * to `renderedCellIndices`, so `captureScrollAnchor` would select
   * one of those newly-rendered cells as anchor. That cell sits at
   * the top of its (now grown) row and didn't move relative to itself,
   * so `restoreScrollAnchor` computes delta=0 — even though cells
   * below in the buffer visibly shifted.
   *
   * Sentinel encoding: `undefined` = no capture attempted yet for the
   * current batch; `null` = capture attempted but no anchor was found
   * (e.g. not virtualized, programmatic scroll in progress, or no
   * visible cells). The rAF must honor both — re-capturing on `null`
   * would defeat the pre-mutation timing.
   */
  private pendingScrollAnchor:
    | { cell: HTMLDivElement; viewportOffset: number }
    | null
    | undefined = undefined;

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

  private sentinelIsIntersecting = false;

  /**
   * Set when `scrollThresholdReached` fires; suppresses further events until
   * `itemCount` changes and the resulting render has painted.  This prevents
   * rapid-fire threshold events from the sentinel, while still allowing the
   * event to re-fire after new content has been laid out.
   */
  private sentinelEventPending = false;

  private bufferStabilizedResolver?: () => void;

  /**
   * The latest stabilization promise. Always set: initialized in the
   * constructor and re-created by `beginStabilization` when a new
   * stabilization cycle starts. Stays in place (in its resolved state)
   * between cycles, so the `bufferStabilized` getter can return it
   * directly without a fallback.
   */
  private bufferStabilizedPromise!: Promise<void>;

  constructor() {
    super();
    // Eagerly stabilize the buffer as soon as the component is created,
    // so consumers that immediately read the `bufferStabilized` promise
    // will receive the real pending promise instead of just a temporary
    // already-resolved one.
    this.beginStabilization();
  }

  /** @inheritdoc */
  get bufferStabilized(): Promise<void> {
    return this.bufferStabilizedPromise;
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

  /** Whether the scroller should use its virtualized mode */
  private get isVirtualized(): boolean {
    return !this.scrollOptimizationsDisabled && this.supportsGrid;
  }

  private sentinelIntersectionObserver: IntersectionObserver =
    new IntersectionObserver(entries => {
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
    });

  private cellIntersectionObserver: IntersectionObserver =
    new IntersectionObserver(entries => {
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
    });

  /** @inheritdoc */
  reload() {
    for (const index of this.renderedCellIndices) {
      this.removeCell(index);
    }

    this.renderedCellIndices.clear();
    this.visibleCellIndices.clear();
    this.placeholderCellIndices.clear();
    this.cellHeights.clear();
    this.rowHeights.clear();

    this.placeholderRowHeight = undefined;
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
        if (this.cellHeights.delete(index)) {
          this.rebuildRowHeightsFromCellHeights();
          this.scheduleScrollLayoutUpdate();
        }
        return;
      }
      this.captureAnchorIfPending();
    }
    this.removeCell(index);
    // In virtualized mode, the early-return above already confirmed `index` is
    // in [bufferStart, bufferEnd]; in non-virtualized mode, fall back to the
    // bufferRange membership check.
    if (this.isVirtualized || this.bufferRange.includes(index)) {
      this.renderCellBuffer([index]);
      if (this.isVirtualized) this.scheduleScrollLayoutUpdate();
    }
  }

  /** @inheritdoc */
  refreshAllVisibleCells(): void {
    if (this.isVirtualized) this.captureAnchorIfPending();
    const range = this.bufferRange;
    range.forEach(index => this.removeCell(index));
    this.renderCellBuffer(range);
    if (this.isVirtualized) this.scheduleScrollLayoutUpdate();
  }

  /**
   * Capture a scroll anchor synchronously and stash it in
   * `pendingScrollAnchor` for the next `scheduleScrollLayoutUpdate`
   * rAF to consume. Within a batch of refreshes (e.g., many
   * setTimeout placeholder loads firing in the same task) only the
   * FIRST call actually captures — the anchor must reflect the
   * pre-mutation layout, before any synchronous `render(...)` call
   * from removeCell/renderCellBuffer has shifted row heights.
   */
  private captureAnchorIfPending(): void {
    if (this.pendingScrollAnchor !== undefined) return;
    this.pendingScrollAnchor = this.captureScrollAnchor();
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

    // We don't want to handle all scroll events normally while we're animating
    // a scroll to a cell, so flag it for now.
    this.scrollToCellInProgress = true;

    // Cancel any pending scroll idle timer
    if (this.scrollRafId) {
      cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = 0;
    }
    if (this.scrollIdleTimer) {
      clearTimeout(this.scrollIdleTimer);
      this.scrollIdleTimer = 0;
    }

    // Shift buffer to include the target, using estimated row heights
    // since the new buffer's cells have not been rendered or measured
    // yet. The bounds must be snapped to row boundaries (multiples of `cols`),
    // otherwise the CSS grid lays the buffered cells out from column 0
    // instead of from the target cell's true column, producing a visual
    // misalignment that the next computeBufferFromScroll would correct
    // with a visible jump.
    const container = this.getScrollContainer();
    const viewportHeight = this.isDocumentScroller(container)
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

    // First we render cells for the buffer range and fill them with content.
    // Once rendered, we can measure their real heights and recompute the
    // scroll-spacer height and buffer transform offset based on accurate
    // measurements, then scroll the targeted cell into view accurately.
    await this.updateComplete;
    return new Promise(resolve => {
      requestAnimationFrame(async () => {
        this.measureBufferedCells();
        this.updateScrollLayout();
        this.requestUpdate();
        await this.updateComplete;

        const targetCell = this.cellContainerForIndex(index);
        if (!targetCell) {
          this.scrollToCellInProgress = false;
          resolve(false);
          return;
        }
        targetCell.scrollIntoView({ behavior });

        if (!animated) {
          // Synchronous scroll has already completed.
          this.scrollToCellInProgress = false;
          resolve(true);
          return;
        }

        // Smooth scroll: keep scrollToCellInProgress=true until the
        // animation settles. Otherwise handleScroll would fire during
        // the animation, trigger computeBufferFromScroll, and the buffer
        // shift's scroll anchoring would call scrollBy — which cancels
        // the in-flight smooth scroll and strands the user well short
        // of the target. Wait for scrollend (preferred) or a fallback
        // timer (for browsers without scrollend).
        const scrollContainer = this.getScrollContainer();
        const eventTarget: EventTarget = this.isDocumentScroller(
          scrollContainer
        )
          ? window
          : scrollContainer;
        let fallbackId = 0;
        let cleaned = false;
        const cleanup = (): void => {
          if (cleaned) return;
          cleaned = true;
          eventTarget.removeEventListener('scrollend', cleanup);
          if (fallbackId) window.clearTimeout(fallbackId);
          this.scrollToCellInProgress = false;
          resolve(true);
        };
        eventTarget.addEventListener('scrollend', cleanup, { once: true });
        // Fallback for browsers without scrollend (older Firefox / Safari)
        // and as a safety net if the event is dropped. 2 seconds covers
        // a long smooth-scroll animation; if the actual scroll runs
        // longer, the buffer will resume normal updates a bit early but
        // the animation itself isn't disrupted (we don't call scrollBy).
        fallbackId = window.setTimeout(cleanup, 2000);
      });
    });
  }

  /** @inheritdoc */
  getVisibleCellIndices(): number[] {
    return Array.from(this.visibleCellIndices);
  }

  willUpdate(changed: PropertyValues) {
    if (changed.has('itemCount')) {
      this.pruneStaleIndices();
      if (this.isVirtualized) {
        this.updateScrollLayout();
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
          this.computeBufferFromScroll();
        });
      }
    }
  }

  connectedCallback() {
    super.connectedCallback?.();
    this.scrollContainer = undefined;
    this.observeSentinel();
    this.setupObservations();
    // firstUpdated() only runs once per element lifetime, so after a
    // disconnect/reconnect cycle the ResizeObserver it set up was permanently
    // severed by disconnectedCallback's resizeObserver.disconnect(). Re-observe
    // the container here so column-count and host-resize changes still propagate.
    if (this.resizeObserver && this.container) {
      this.resizeObserver.observe(this.container);
    }
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

  private setupScrollListener(): void {
    this.teardownScrollListener();
    const container = this.getScrollContainer();
    const target = this.isDocumentScroller(container) ? window : container;
    target.addEventListener('scroll', this.handleScroll, { passive: true });
    this.scrollListenersActive = true;
  }

  private teardownScrollListener(): void {
    if (!this.scrollListenersActive) return;
    if (this.scrollContainer) {
      const target = this.isDocumentScroller(this.scrollContainer)
        ? window
        : this.scrollContainer;
      target.removeEventListener('scroll', this.handleScroll);
    }

    if (this.scrollRafId) {
      cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = 0;
    }
    if (this.scrollLayoutRafId) {
      cancelAnimationFrame(this.scrollLayoutRafId);
      this.scrollLayoutRafId = 0;
    }
    if (this.scrollIdleTimer) {
      clearTimeout(this.scrollIdleTimer);
      this.scrollIdleTimer = 0;
    }
    this.scrollListenersActive = false;
  }

  /**
   * Whether the given element is the document-level scroller.
   */
  private isDocumentScroller(elmt: Element): boolean {
    return (
      elmt === document.scrollingElement || elmt === document.documentElement
    );
  }

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
   * per-shift formula in `computeBufferFromScroll` because we don't yet
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
   * Finds and returns the nearest scrolling container in this component's ancestry.
   */
  private getScrollContainer(): Element {
    if (this.scrollContainer) return this.scrollContainer;
    let el: Element | null = this;
    while (el) {
      el = el.parentElement;
      if (!el) break;
      const { overflowY } = getComputedStyle(el);
      if (overflowY === 'auto' || overflowY === 'scroll') {
        this.scrollContainer = el;
        return el;
      }
    }
    this.scrollContainer =
      document.scrollingElement ?? document.documentElement;
    return this.scrollContainer;
  }

  /**
   * Updates the saved height of the given cell and recomputes its row's height
   * as the max over all measured cells in that row. We need max-over-cells
   * (not a monotone-up ratchet) so the row height shrinks back down when a
   * tall placeholder is replaced by shorter content.
   */
  private recordCellHeight(cellIndex: number, height: number): void {
    this.cellHeights.set(cellIndex, height);
    this.updateRowHeightFromCells(
      Math.floor(cellIndex / this.cachedColumnsPerRow)
    );
  }

  /**
   * Recomputes the cached height for `row` as the max over all currently
   * measured cells in that row. Removes the entry if no cells are measured.
   */
  private updateRowHeightFromCells(row: number): void {
    const cols = this.cachedColumnsPerRow;
    const firstCellInRow = row * cols;
    let maxHeight = 0;
    for (let c = 0; c < cols; c += 1) {
      const h = this.cellHeights.get(firstCellInRow + c);
      if (h !== undefined && h > maxHeight) maxHeight = h;
    }
    if (maxHeight > 0) {
      this.rowHeights.set(row, maxHeight);
    } else {
      this.rowHeights.delete(row);
    }
  }

  /**
   * Refreshes the heights of all rows, for instance because of a change in
   * the grid parameters or a resize.
   */
  private rebuildRowHeightsFromCellHeights(): void {
    this.rowHeights.clear();
    const rowsToUpdate = new Set<number>();
    for (const cellIndex of this.cellHeights.keys()) {
      rowsToUpdate.add(Math.floor(cellIndex / this.cachedColumnsPerRow));
    }
    rowsToUpdate.forEach(r => this.updateRowHeightFromCells(r));
  }

  /**
   * Sums the (estimated or measured) heights of all rows in the inclusive
   * range `[startRow, endRow]`, plus the row gaps between them. Used to
   * compute both the total scroll-spacer height (sum across all rows)
   * and the buffer transform offset (sum across the rows preceding the
   * buffer's first row). Returns 0 when the range is empty.
   */
  private sumRowHeights(startRow: number, endRow: number): number {
    if (endRow < startRow) return 0;
    const { rowGap } = this;
    let total = 0;
    for (let r = startRow; r <= endRow; r += 1) {
      total +=
        this.rowHeights.get(r) ??
        this.placeholderRowHeight ??
        this.defaultRowHeight;
    }
    total += Math.max(0, endRow - startRow) * rowGap;
    return total;
  }

  /**
   * Recompute the two derived scroll-layout values that depend on the
   * current per-row height estimates:
   *  - `totalContentHeight`: the height the scroll spacer needs to be
   *    so the document can scroll across the entire virtual content,
   *    including the unrendered rows above and below the buffer.
   *  - `bufferOffsetY`: the Y offset (via CSS transform) at which the
   *    rendered buffer is positioned within that virtual space, so it
   *    visually occupies the rows the user has scrolled to.
   *
   * Called after `rowHeights` changes — e.g. after `measureBufferedCells`
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
    this.totalContentHeight = this.sumRowHeights(0, totalRows - 1);
    const bufferStartRow = Math.floor(
      this.bufferStart / this.cachedColumnsPerRow
    );
    // sumRowHeights(0, k-1) returns sum(heights) + (k-1) * rowGap.
    // Row k's top edge is at sum(heights) + k*rowGap, so add one rowGap.
    this.bufferOffsetY =
      bufferStartRow > 0
        ? this.sumRowHeights(0, bufferStartRow - 1) + this.rowGap
        : 0;
  }

  /**
   * Event handler for passive scroll events, throttled to minimize unnecessary updates.
   */
  private handleScroll = (): void => {
    if (this.scrollToCellInProgress) return;
    if (this.suppressScrollHandlerOnce) {
      // We just adjusted scrollTop for scroll anchoring; ignore the resulting
      // event so the recompute doesn't reverse our compensation.
      this.suppressScrollHandlerOnce = false;
      return;
    }
    if (!this.scrollRafId) {
      this.scrollRafId = requestAnimationFrame(() => {
        this.scrollRafId = 0;
        this.computeBufferFromScroll();
      });
    }
    // Fire the idle handling only once, after scrolling stops
    if (this.scrollIdleTimer) clearTimeout(this.scrollIdleTimer);
    this.scrollIdleTimer = window.setTimeout(() => {
      this.scrollIdleTimer = 0;
      this.computeBufferFromScroll();
    }, 150);
  };

  /**
   * Find the topmost cell currently visible in the viewport and record its
   * viewport-relative top position. Used as a "scroll anchor" before any
   * operation that might shift `bufferOffsetY` or change in-buffer row
   * heights under the user's fixed `scrollTop`. Pair every call to this
   * with `restoreScrollAnchor`.
   *
   * We prefer a **rendered (content) cell** over a placeholder when one is
   * visible. The user's mental model is anchored on the actual content
   * they're looking at, not on a generic placeholder graphic — if a
   * placeholder happens to slide into the topmost-visible position as the
   * buffer shifts, anchoring to it would let the surrounding content
   * drift. Falls back to the topmost visible placeholder when no
   * rendered cell is in view.
   */
  private captureScrollAnchor(): {
    cell: HTMLDivElement;
    viewportOffset: number;
  } | null {
    if (!this.isVirtualized) return null;
    if (this.scrollToCellInProgress) return null;
    const scrollContainer = this.getScrollContainer();
    const isDoc = this.isDocumentScroller(scrollContainer);
    const viewportTop = isDoc ? 0 : scrollContainer.getBoundingClientRect().top;
    const viewportBottom = isDoc
      ? window.innerHeight
      : viewportTop + scrollContainer.clientHeight;
    // Walk cells in DOM order (= index order). For each visible cell,
    // remember the first one we see as a fallback. As soon as we find a
    // visible *rendered* cell, return it immediately. Stop iterating once
    // we pass the viewport bottom.
    //
    // If there's no rendered content anywhere in the buffer (e.g. the user
    // just jumped to an unloaded region), short-circuit to the first
    // visible cell — no point walking the viewport looking for content
    // that doesn't exist.
    const lookForContent = this.renderedCellIndices.size > 0;
    let fallback: { cell: HTMLDivElement; viewportOffset: number } | null =
      null;
    for (const cell of this.cellContainers) {
      const rect = cell.getBoundingClientRect();
      if (rect.top >= viewportBottom) break;
      if (rect.bottom >= viewportTop) {
        const idxStr = cell.dataset.cellIndex;
        if (idxStr !== undefined) {
          const anchor = { cell, viewportOffset: rect.top - viewportTop };
          if (lookForContent && this.renderedCellIndices.has(Number(idxStr))) {
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
  private restoreScrollAnchor(
    anchor: { cell: HTMLDivElement; viewportOffset: number } | null
  ): void {
    if (!anchor) return;
    // The anchor cell may have been removed from the DOM if the buffer
    // shifted such that it's no longer rendered. Skip in that case — the
    // user will still see *some* cell, and the next scroll event will
    // settle things.
    if (!anchor.cell.isConnected) return;
    const scrollContainer = this.getScrollContainer();
    const isDoc = this.isDocumentScroller(scrollContainer);
    const viewportTop = isDoc ? 0 : scrollContainer.getBoundingClientRect().top;
    const newRect = anchor.cell.getBoundingClientRect();
    const delta = newRect.top - viewportTop - anchor.viewportOffset;
    // Sub-pixel deltas can result from fractional layout math; skip them
    // to avoid jitter on hidpi displays.
    if (Math.abs(delta) < 0.5) return;
    this.suppressScrollHandlerOnce = true;
    if (isDoc) {
      window.scrollBy(0, delta);
    } else {
      scrollContainer.scrollTop += delta;
    }
  }

  /**
   * Schedule one rAF that re-measures buffered cell heights, recomputes
   * `totalContentHeight` and `bufferOffsetY` (the scroll-layout values
   * that determine how tall the spacer is and where the rendered buffer
   * sits within it), and re-anchors the visible scroll position. Called
   * after any synchronous DOM mutation that could change in-buffer row
   * heights — chiefly `refreshCell` during async data load. Multiple
   * calls in the same task coalesce into a single rAF.
   *
   * We deliberately do NOT call `computeBufferFromScroll` here — that
   * could shift bufferStart/bufferEnd and remove the very cell whose
   * refresh just triggered this update. Only the scroll-layout values
   * are recomputed; the buffer window stays fixed.
   */
  private scheduleScrollLayoutUpdate(): void {
    if (this.scrollLayoutRafId) return;
    this.scrollLayoutRafId = requestAnimationFrame(() => {
      this.scrollLayoutRafId = 0;
      // Prefer the anchor captured synchronously by refreshCell/
      // refreshAllVisibleCells *before* their render() calls mutated the
      // DOM. Capturing here in the rAF would see the post-mutation
      // renderedCellIndices and pick a newly-rendered cell as anchor —
      // one that sits at the top of its own grown row and didn't move.
      // For paths that don't pre-capture (e.g., outside-buffer cleanup),
      // fall back to capturing now.
      const anchor =
        this.pendingScrollAnchor !== undefined
          ? this.pendingScrollAnchor
          : this.captureScrollAnchor();
      this.pendingScrollAnchor = undefined;
      const prevTotal = this.totalContentHeight;
      const prevOffset = this.bufferOffsetY;
      this.measureBufferedCells();
      this.updateScrollLayout();
      if (
        prevTotal !== this.totalContentHeight ||
        prevOffset !== this.bufferOffsetY
      ) {
        this.requestUpdate();
        this.updateComplete.then(() => this.restoreScrollAnchor(anchor));
      } else {
        // Geometry didn't change but in-buffer row heights might still have
        // (the spacer total and bufferOffsetY can stay constant while
        // individual row heights inside the buffer change). Re-anchor anyway.
        this.restoreScrollAnchor(anchor);
      }
    });
  }

  private measureBufferedCells(): void {
    for (const cell of this.cellContainers) {
      const indexStr = cell.dataset.cellIndex;
      if (indexStr) {
        const index = parseInt(indexStr, 10);
        if (this.renderedCellIndices.has(index) && cell.offsetHeight > 0) {
          this.recordCellHeight(index, cell.offsetHeight);
        }
      }
    }

    this.updatePlaceholderRowHeight();
  }

  /**
   * Estimates the typical placeholder row height by averaging the offsetHeight
   * of placeholders that lie in **pure-placeholder rows** (rows containing no
   * rendered/measured siblings). Mixed rows inflate placeholder cells to the
   * row's max, which biases a single-sample capture. By restricting to pure-
   * placeholder rows we get a clean signal of the placeholder's intrinsic
   * height; if no pure rows are currently buffered we keep the previous
   * estimate rather than overwriting it with an inflated value.
   */
  private updatePlaceholderRowHeight(): void {
    if (this.placeholderCellIndices.size === 0) return;
    const cols = this.cachedColumnsPerRow;
    // Bucket buffered placeholders by row.
    const rowToPlaceholders = new Map<number, number[]>();
    for (const idx of this.placeholderCellIndices) {
      const row = Math.floor(idx / cols);
      const existing = rowToPlaceholders.get(row);
      if (existing) existing.push(idx);
      else rowToPlaceholders.set(row, [idx]);
    }
    let sum = 0;
    let count = 0;
    for (const [row, indices] of rowToPlaceholders) {
      // Skip mixed rows: any currently-rendered content cell in the row
      // means the placeholder heights in that row are forced by CSS grid
      // to match the rendered siblings.
      //
      // We deliberately check `renderedCellIndices` rather than `cellHeights`
      // — the latter persists across buffer shifts (so cells the user
      // scrolled past long ago still appear as "measured"), but the row's
      // *current* render only depends on cells that are presently in the
      // buffer as content. Using `cellHeights.has` here would treat almost
      // every row as mixed after even modest scrolling, leaving the
      // placeholder estimate permanently unupdated.
      const firstCellInRow = row * cols;
      let isMixed = false;
      for (let c = 0; c < cols; c += 1) {
        if (this.renderedCellIndices.has(firstCellInRow + c)) {
          isMixed = true;
          break;
        }
      }
      if (!isMixed) {
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
    // If no pure-placeholder rows are currently buffered, keep the previous
    // estimate rather than overwriting with an inflated mixed-row value.
  }

  /**
   * Updates the "default" row height used as an estimate to match the average
   * height of all known, measured rows.
   */
  private updateDefaultRowHeightFromMeasured(): void {
    if (this.rowHeights.size === 0) return;
    let sum = 0;
    for (const h of this.rowHeights.values()) sum += h;
    this.defaultRowHeight = sum / this.rowHeights.size;
  }

  private computeBufferFromScroll(): void {
    // Need to re-measure heights of buffered cells, since child components may have
    // rendered since the cells were created
    this.measureBufferedCells();

    const scrollContainer = this.getScrollContainer();
    if (!this.container) return;

    const cols = this.cachedColumnsPerRow;
    const { rowGap } = this;
    const totalRows = this.getTotalRows();
    if (totalRows === 0) return;

    // Determine visible viewport relative to the content area
    let scrollTop: number;
    let viewportHeight: number;
    if (this.isDocumentScroller(scrollContainer)) {
      scrollTop = window.scrollY;
      viewportHeight = window.innerHeight;
    } else {
      scrollTop = scrollContainer.scrollTop;
      viewportHeight = scrollContainer.clientHeight;
    }

    const rectElement = this.scrollSpacer ?? this.container;
    const spacerRect = rectElement.getBoundingClientRect();
    const containerTopInScroller = this.isDocumentScroller(scrollContainer)
      ? spacerRect.top + window.scrollY
      : spacerRect.top +
        scrollContainer.scrollTop -
        scrollContainer.getBoundingClientRect().top;

    const relativeScrollTop = scrollTop - containerTopInScroller;
    const relativeScrollBottom = relativeScrollTop + viewportHeight;

    // Walk row heights to find first and last visible rows
    let heightSoFar = 0;
    let firstVisibleRow = 0;
    let lastVisibleRow = totalRows - 1;
    let foundFirst = false;

    for (let r = 0; r < totalRows; r += 1) {
      const rowHeight =
        this.rowHeights.get(r) ??
        this.placeholderRowHeight ??
        this.defaultRowHeight;
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

    const minBufferRows = Math.ceil(this.minBufferSize / cols);
    const numVisibleRows = lastVisibleRow - firstVisibleRow + 1;
    const proportionalRows = Math.ceil(numVisibleRows * this.bufferMultiplier);
    const bufferRows = Math.max(minBufferRows, proportionalRows);

    // Skip recentering if current buffer still has adequate margin (since otherwise
    // we can end up jittering back and forth)
    const currentStartRow = Math.floor(this.bufferStart / cols);
    const currentEndRow = Math.floor(
      Math.min(this.bufferEnd, this.itemCount - 1) / cols
    );
    const minMargin = Math.max(2, Math.floor(bufferRows / 3));
    if (
      firstVisibleRow >= currentStartRow + minMargin &&
      lastVisibleRow <= currentEndRow - minMargin
    ) {
      return;
    }

    // Since placeholder rows may be sized differently from fully-rendered ones,
    // walk the visible rows to determine a more fine-grained buffer px size so
    // that the buffer can be resized accordingly without blank spaces.
    const minBufferPx = viewportHeight * Math.max(1, this.bufferMultiplier);

    let newStartRow = firstVisibleRow;
    let startPx = 0;
    while (newStartRow > 0 && startPx < minBufferPx) {
      newStartRow -= 1;
      startPx +=
        (this.rowHeights.get(newStartRow) ??
          this.placeholderRowHeight ??
          this.defaultRowHeight) + rowGap;
    }

    let newEndRow = lastVisibleRow;
    let endPx = 0;
    while (newEndRow < totalRows - 1 && endPx < minBufferPx) {
      newEndRow += 1;
      endPx +=
        (this.rowHeights.get(newEndRow) ??
          this.placeholderRowHeight ??
          this.defaultRowHeight) + rowGap;
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

    const newStart = newStartRow * cols;
    const newEnd = Math.min((newEndRow + 1) * cols - 1, this.itemCount - 1);

    if (newStart !== this.bufferStart || newEnd !== this.bufferEnd) {
      // Capture the visible anchor before mutating bufferStart/bufferEnd. The
      // buffer shift typically changes bufferOffsetY by a different amount
      // than the user's scrollTop just changed (e.g., when newly-absorbed
      // rows have stale content-sized rowHeights from prior browsing), which
      // would otherwise yank the visible content forward or backward.
      const anchor = this.captureScrollAnchor();

      // Need to update the fallback height estimates together so the
      // values agree when sumRowHeights walks the rows to recompute
      // the scroll-spacer height and buffer transform offset.
      //
      // We intentionally do NOT clear placeholderRowHeight here even when the
      // current buffer happens to contain no placeholders: that signal only
      // tells us about the current window, not whether placeholders exist
      // elsewhere in the data. Clearing it caused bufferOffsetY to oscillate
      // between a placeholderRowHeight-based estimate and a defaultRowHeight-
      // based one as the user scrolled through mixed-load regions, producing
      // visible "snap back / snap forward" jumps. The estimate is reset only
      // on reload() or column-count change (where it is genuinely invalid).
      if (this.rowHeights.size > 0) {
        this.updateDefaultRowHeightFromMeasured();
      }
      this.bufferStart = newStart;
      this.bufferEnd = newEnd;
      this.updateScrollLayout();
      // Lit needs to re-render with the new buffer + transform before
      // bounding-rect reads will reflect the new layout. Defer the anchor
      // restoration accordingly.
      this.updateComplete.then(() => this.restoreScrollAnchor(anchor));
    }
  }

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

    // Set up scroll listener
    this.setupScrollListener();

    // Set up a resize observer for layout changes that would require us to
    // recalculate the buffer. Defers its actual work to an animation frame
    // so that internal layout mutations this tick don't trigger the observer.
    let resizeRafId = 0;
    this.resizeObserver = new ResizeObserver(() => {
      if (resizeRafId) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = 0;
        const newCols = this.getColumnsPerRow();
        if (newCols !== this.cachedColumnsPerRow) {
          this.cachedColumnsPerRow = newCols;
          this.placeholderRowHeight = undefined;
          this.rebuildRowHeightsFromCellHeights();
          this.updateScrollLayout();
          this.computeBufferFromScroll();
        }
        if (this.rowHeights.size > 0) {
          this.updateDefaultRowHeightFromMeasured();
        } else {
          this.defaultRowHeight = this.computeDefaultRowHeight();
        }
      });
    });
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
      this.updateDefaultRowHeightFromMeasured();
      this.computeBufferFromScroll();
      this.updateComplete.then(() => {
        this.endStabilization();
      });
    });
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
    for (const index of this.cellHeights.keys()) {
      if (index >= this.itemCount) this.cellHeights.delete(index);
    }
    this.rebuildRowHeightsFromCellHeights();
  }

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
        if (this.cellHeights.delete(index)) {
          this.updateRowHeightFromCells(
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
    if (this.cellHeights.delete(index)) {
      this.rebuildRowHeightsFromCellHeights();
    }
  }

  private cellContainerForIndex(index: number): HTMLDivElement | null {
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
