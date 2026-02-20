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
   * Estimated height of each cell in pixels, used for strut sizing before
   * real measurements are available. Consumers can set this to match their
   * expected content height for more accurate initial scroll positioning.
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
  @property({ type: Number }) bufferSize = 10;

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

  private cachedColumnsPerRow = 1;

  private defaultRowHeight = INITIAL_ROW_HEIGHT;

  private cellHeights = new Map<number, number>();

  private rowHeights = new Map<number, number>();

  private placeholderRowHeight: number | undefined;

  private measuredRowHeightSum = 0;

  private measuredRowHeightCount = 0;

  private totalContentHeight = 0;

  private bufferOffsetY = 0;

  private supportsGrid =
    typeof CSS !== 'undefined' && CSS.supports('display', 'grid');

  private resizeObserver?: ResizeObserver;

  private scrollContainer?: Element;

  private scrollRafId = 0;

  private scrollIdleTimer = 0;

  private scrollListenersActive = false;

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

  private _bufferStabilizedResolver?: () => void;

  private _bufferStabilizedPromise?: Promise<void>;

  /** @inheritdoc */
  get bufferStabilized(): Promise<void> {
    return this._bufferStabilizedPromise ?? Promise.resolve();
  }

  private beginStabilization(): void {
    if (!this._bufferStabilizedResolver) {
      this._bufferStabilizedPromise = new Promise(resolve => {
        this._bufferStabilizedResolver = resolve;
      });
    }
  }

  private endStabilization(): void {
    this._bufferStabilizedPromise = undefined;
    this._bufferStabilizedResolver?.();
    this._bufferStabilizedResolver = undefined;
    this.dispatchEvent(new Event('bufferStabilized'));
  }

  private get isVirtualized(): boolean {
    return !this.scrollOptimizationsDisabled && this.supportsGrid;
  }

  private sentinelIsIntersecting = false;

  /**
   * Set when `scrollThresholdReached` fires; suppresses further events until
   * `itemCount` changes and the resulting render has painted.  This prevents
   * rapid-fire events from sentinel re-observation while still allowing the
   * event to re-fire after new content has been laid out.
   */
  private sentinelEventPending = false;

  private sentinelObserver: IntersectionObserver = new IntersectionObserver(
    entries => {
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
  );

  private intersectionObserver: IntersectionObserver = new IntersectionObserver(
    entries => {
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
  );

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
    this.measuredRowHeightSum = 0;
    this.measuredRowHeightCount = 0;
    this.placeholderRowHeight = undefined;
    this.sentinelEventPending = false;
    this.sentinelIsIntersecting = false;
    this.totalContentHeight = 0;
    this.bufferOffsetY = 0;
    this.bufferStart = 0;
    const estimatedVisibleRows = Math.ceil(
      window.innerHeight / this.defaultRowHeight
    );
    const minBuffer = this.bufferSize * 2;
    const proportionalBuffer =
      estimatedVisibleRows *
      (1 + this.bufferMultiplier * 2) *
      this.cachedColumnsPerRow;
    this.bufferEnd = Math.min(
      Math.max(minBuffer, proportionalBuffer),
      this.itemCount - 1
    );
    this.updateScrollGeometry();
    this.setupObservations();
    // Re-observe the sentinel so it can fire again with a clean state
    if (this.sentinel) {
      this.sentinelObserver.unobserve(this.sentinel);
      this.sentinelObserver.observe(this.sentinel);
    }
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
        }
        return;
      }
    }
    this.removeCell(index);
    if (this.bufferRange.includes(index)) {
      this.renderCellBuffer([index]);
    }
  }

  /** @inheritdoc */
  refreshAllVisibleCells(): void {
    this.bufferRange.forEach(index => this.removeCell(index));
    this.renderCellBuffer(this.bufferRange);
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

    // Shift buffer to include the target, estimating the strut heights
    const sc = this.getScrollContainer();
    const viewportHeight = this.isDocumentScroller(sc)
      ? window.innerHeight
      : sc.clientHeight;
    const cols = this.cachedColumnsPerRow;
    const visibleRows = Math.ceil(viewportHeight / this.defaultRowHeight);
    const minBufferRows = Math.ceil(this.bufferSize / cols);
    const proportionalRows = Math.ceil(visibleRows * this.bufferMultiplier);
    const bufferCells = Math.max(minBufferRows, proportionalRows) * cols;
    this.bufferStart = Math.max(0, index - bufferCells);
    this.bufferEnd = Math.min(this.itemCount - 1, index + bufferCells);
    this.updateScrollGeometry();

    // First we render cells for the buffer range and fill them with content.
    // Once rendered, we can measure their real heights and recompute the struts
    // to match based on the correct positions, and scroll the targeted cell into
    // view accurately.
    await this.updateComplete;
    requestAnimationFrame(async () => {
      this.measureBufferedCells();
      this.updateScrollGeometry();
      this.requestUpdate();
      await this.updateComplete;
      const targetCell = this.cellContainerForIndex(index);
      if (targetCell) {
        targetCell.scrollIntoView({ behavior });
      }
    });

    return true;
  }

  /** @inheritdoc */
  getVisibleCellIndices(): number[] {
    return Array.from(this.visibleCellIndices);
  }

  willUpdate(changed: PropertyValues) {
    if (changed.has('itemCount')) {
      this.pruneStaleIndices();
      if (this.isVirtualized) {
        this.updateScrollGeometry();
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

    // If virtualization is needed, ensure buffered cells are rendered and re-observed
    // after DOM updates
    if (
      this.isVirtualized &&
      (changed.has('bufferStart') || changed.has('bufferEnd'))
    ) {
      this.processVisibleCells();
      this.setupVirtualizedObservations();
      if (!this.scrollRafId) {
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
  }

  disconnectedCallback() {
    this.sentinelObserver.disconnect();
    this.intersectionObserver.disconnect();
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
    const sc = this.getScrollContainer();
    const target = this.isDocumentScroller(sc) ? window : sc;
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
   * Updates the saved height of the current cell and updates its row height
   * if necessary.
   */
  private recordCellHeight(cellIndex: number, height: number): void {
    this.cellHeights.set(cellIndex, height);
    const row = Math.floor(cellIndex / this.cachedColumnsPerRow);
    const current = this.rowHeights.get(row) ?? 0;
    if (height > current) {
      this.rowHeights.set(row, height);
      if (current > 0) {
        this.measuredRowHeightSum += height - current;
      } else {
        this.measuredRowHeightSum += height;
        this.measuredRowHeightCount += 1;
      }
    }
  }

  /**
   * Refreshes the heights of all rows, for instance because of a change in
   * the grid parameters or a resize.
   */
  private rebuildRowHeightsFromCellHeights(): void {
    this.rowHeights.clear();
    for (const [cellIndex, height] of this.cellHeights) {
      const row = Math.floor(cellIndex / this.cachedColumnsPerRow);
      const current = this.rowHeights.get(row) ?? 0;
      if (height > current) this.rowHeights.set(row, height);
    }
  }

  /**
   * Calculates the best-effort height of a strut element to represent all rows between the
   * given start/end row indices, inclusive.
   */
  private computeStrutHeight(startRow: number, endRow: number): number {
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

  private updateScrollGeometry(): void {
    const totalRows = this.getTotalRows();
    if (totalRows === 0) {
      this.totalContentHeight = 0;
      this.bufferOffsetY = 0;
      return;
    }
    this.totalContentHeight = this.computeStrutHeight(0, totalRows - 1);
    const bufferStartRow = Math.floor(
      this.bufferStart / this.cachedColumnsPerRow
    );
    // computeStrutHeight(0, k-1) gives sum(heights) + (k-1) * rowGap.
    // Row k's top edge is at sum(heights) + k*rowGap, so add one rowGap.
    this.bufferOffsetY =
      bufferStartRow > 0
        ? this.computeStrutHeight(0, bufferStartRow - 1) + this.rowGap
        : 0;
  }

  /**
   * Event handler for passive scroll events, throttled to minimize unnecessary updates.
   */
  private handleScroll = (): void => {
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

    if (
      this.placeholderCellIndices.size > 0 &&
      this.placeholderRowHeight === undefined
    ) {
      const firstPlaceholderIndex = this.placeholderCellIndices
        .values()
        .next().value;
      const cell = this.cellContainerForIndex(firstPlaceholderIndex!);
      if (cell && cell.offsetHeight > 0) {
        this.placeholderRowHeight = cell.offsetHeight;
      }
    }
  }

  /**
   * Updates the "default" row height used as an estimate to match the average
   * height of all known, measured rows.
   */
  private updateDefaultRowHeightFromMeasured(): void {
    if (this.measuredRowHeightCount === 0) return;
    this.defaultRowHeight =
      this.measuredRowHeightSum / this.measuredRowHeightCount;
  }

  private computeBufferFromScroll(): void {
    // Need to re-measure heights of buffered cells, since child components may have
    // rendered since the cells were created
    this.measureBufferedCells();

    const scroller = this.getScrollContainer();
    if (!this.container) return;

    const cols = this.cachedColumnsPerRow;
    const { rowGap } = this;
    const totalRows = this.getTotalRows();
    if (totalRows === 0) return;

    // Determine visible viewport relative to the content area
    let scrollTop: number;
    let viewportHeight: number;
    if (this.isDocumentScroller(scroller)) {
      scrollTop = window.scrollY;
      viewportHeight = window.innerHeight;
    } else {
      scrollTop = scroller.scrollTop;
      viewportHeight = scroller.clientHeight;
    }

    const rectElement = this.scrollSpacer ?? this.container;
    const spacerRect = rectElement.getBoundingClientRect();
    const containerTopInScroller = this.isDocumentScroller(scroller)
      ? spacerRect.top + window.scrollY
      : spacerRect.top +
        scroller.scrollTop -
        scroller.getBoundingClientRect().top;

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

    const visibleRows = lastVisibleRow - firstVisibleRow + 1;
    const minBufferRows = Math.ceil(this.bufferSize / cols);
    const proportionalRows = Math.ceil(visibleRows * this.bufferMultiplier);
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

    const newStartRow = Math.max(0, firstVisibleRow - bufferRows);
    const newEndRow = Math.min(totalRows - 1, lastVisibleRow + bufferRows);

    const newStart = newStartRow * cols;
    const newEnd = Math.min((newEndRow + 1) * cols - 1, this.itemCount - 1);

    if (newStart !== this.bufferStart || newEnd !== this.bufferEnd) {
      // Need to update the fallback heights/struts together so the estimates agree
      // when we add up the rows and compute struts
      if (this.rowHeights.size > 0) {
        this.updateDefaultRowHeightFromMeasured();
        if (this.placeholderCellIndices.size === 0) {
          this.placeholderRowHeight = undefined;
        }
      }
      this.bufferStart = newStart;
      this.bufferEnd = newEnd;
      this.updateScrollGeometry();
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
    const estimatedVisibleRows = Math.ceil(
      window.innerHeight / this.defaultRowHeight
    );
    const minBuffer = this.bufferSize * 2;
    const proportionalBuffer =
      estimatedVisibleRows *
      (1 + this.bufferMultiplier * 2) *
      this.cachedColumnsPerRow;
    this.bufferEnd = Math.min(
      Math.max(minBuffer, proportionalBuffer),
      this.itemCount - 1
    );
    this.updateScrollGeometry();

    // Set up scroll listener
    this.setupScrollListener();

    // Set up resize observer
    this.resizeObserver = new ResizeObserver(() => {
      const newCols = this.getColumnsPerRow();
      if (newCols !== this.cachedColumnsPerRow) {
        this.cachedColumnsPerRow = newCols;
        this.placeholderRowHeight = undefined;
        this.rebuildRowHeightsFromCellHeights();
        this.updateScrollGeometry();
        this.computeBufferFromScroll();
      }
      if (this.rowHeights.size > 0) {
        this.updateDefaultRowHeightFromMeasured();
      } else {
        this.defaultRowHeight = this.computeDefaultRowHeight();
      }
    });
    if (this.container) this.resizeObserver.observe(this.container);

    this.stabilizeBuffer();
  }

  /**
   * Asynchronously attempts to stabilize the buffered range of cells.
   * Waits a frame after cells paint, measures real heights, recomputes the buffer,
   * and resolves the `stable` promise.
   */
  private stabilizeBuffer(): void {
    this.beginStabilization();
    this.updateComplete.then(() => {
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
    if (this.sentinel) this.sentinelObserver.observe(this.sentinel);
  }

  /**
   * After `itemCount` changes, waits for the re-render (with updated strut
   * heights) and one animation frame for paint, then clears the pending flag
   * and re-observes the sentinel so the IO can re-evaluate whether the user
   * is still near the end.
   */
  private scheduleSentinelRecheck(): void {
    this.updateComplete.then(() => {
      requestAnimationFrame(() => {
        this.sentinelEventPending = false;
        this.sentinelIsIntersecting = false;
        if (this.sentinel) {
          this.sentinelObserver.unobserve(this.sentinel);
          this.sentinelObserver.observe(this.sentinel);
        }
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
    this.intersectionObserver.disconnect();

    // Prune visibleCellIndices to the current buffer range.
    // disconnect() doesn't fire exit callbacks, so indices from a previous
    // buffer would otherwise linger indefinitely
    for (const index of this.visibleCellIndices) {
      if (index < this.bufferStart || index > this.bufferEnd) {
        this.visibleCellIndices.delete(index);
      }
    }

    this.cellContainers.forEach(cell =>
      this.intersectionObserver.observe(cell)
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
    this.intersectionObserver.disconnect();

    if (this.scrollOptimizationsDisabled) {
      const indexArray = generateRange(0, Math.max(0, this.itemCount - 1), 1);
      indexArray.forEach(index => this.visibleCellIndices.add(index));
      this.processVisibleCells();
    } else {
      this.cellContainers.forEach(cell =>
        this.intersectionObserver.observe(cell)
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
      this.updateScrollGeometry();
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

    const noVisibleCells = this.visibleCellIndices.size === 0;
    const minVisibleIndex = Math.min(...this.visibleCellIndices);
    const maxVisibleIndex = Math.max(...this.visibleCellIndices);

    const minBufferIndex = noVisibleCells
      ? 0
      : Math.max(minVisibleIndex - cellBufferSize, 0);
    const maxBufferIndex = noVisibleCells
      ? cellBufferSize
      : Math.min(maxVisibleIndex + cellBufferSize, this.itemCount - 1);

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
    const cellContainer = this.cellContainerForIndex(index);
    if (!cellContainer) {
      // Cell already removed from DOM (e.g., by template re-render in virtualized mode)
      this.renderedCellIndices.delete(index);
      this.placeholderCellIndices.delete(index);
      if (this.cellHeights.delete(index)) {
        this.rebuildRowHeightsFromCellHeights();
      }
      return;
    }
    render(nothing, cellContainer);
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
    return (
      (this.shadowRoot?.querySelector(
        `.cell-container[data-cell-index="${index}"]`
      ) as HTMLDivElement) ?? null
    );
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
