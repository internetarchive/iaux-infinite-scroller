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
import { property, customElement, query, queryAll } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { generateRange } from './range-generator';

export interface InfiniteScrollerCellProviderInterface {
  cellForIndex(index: number): TemplateResult | undefined;
}

export interface InfiniteScrollerInterface extends LitElement {
  /**
   * The number of items in the data source
   */
  itemCount: number;

  /**
   * The cell provider to provide cells for the scroller
   */
  cellProvider?: InfiniteScrollerCellProviderInterface;

  /**
   * Disable scroll optimizations for prerendering
   */
  scrollOptimizationsDisabled: boolean;

  /**
   * Reload the scroller
   */
  reload(): void;

  /**
   * Scroll to a cell index
   *
   * @param index number
   * @param animated boolean
   * @returns boolean if scroll was successful
   */
  scrollToCell(index: number, animated: boolean): boolean;

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

@customElement('infinite-scroller')
export class InfiniteScroller
  extends LitElement
  implements InfiniteScrollerInterface
{
  @property({ type: Number }) itemCount = 0;

  @property({ type: Object })
  cellProvider?: InfiniteScrollerCellProviderInterface;

  @property({ type: Object }) placeholderCellTemplate?: TemplateResult;

  /**
   * Disable scroll optimizations, such as lazy loading of cells
   * and removal when they're not on-screen.
   *
   * Scroll optimizations are useful for most browser-usage, but when pre-rendering with Rendertron,
   * the optimizations only show the first 10 cells and with a static page, we want
   * to see them all.
   *
   * @memberof InfiniteScroller
   */
  @property({ type: Boolean }) scrollOptimizationsDisabled = false;

  /**
   * The sentinel is our marker to know when we need to load more data
   *
   * @type {HTMLDivElement}
   * @memberof InfiniteScroller
   */
  @query('#sentinel') private sentinel?: HTMLDivElement;

  @queryAll('.cell-container') private cellContainers!: HTMLDivElement[];

  private intersectionObserver?: IntersectionObserver;

  /** @inheritdoc */
  reload() {
    const range = generateRange(0, Math.max(0, this.itemCount - 1), 1);
    range.forEach(index => this.removeCell(index));
    this.renderedCellIndices.clear();
    this.visibleCellIndices.clear();
    this.placeholderCellIndices.clear();
    this.setupObservations();
  }

  /** @inheritdoc */
  scrollToCell(index: number, animated: boolean): boolean {
    const cellContainer = this.cellContainers[index];
    if (!cellContainer) return false;
    const behavior = animated ? 'smooth' : 'auto';
    cellContainer.scrollIntoView({ behavior });
    return true;
  }

  /** @inheritdoc */
  getVisibleCellIndices(): number[] {
    return Array.from(this.visibleCellIndices);
  }

  updated(changed: PropertyValues) {
    if (
      changed.has('itemCount') ||
      changed.has('scrollOptimizationsDisabled')
    ) {
      this.setupObservations();
    }
  }

  disconnectedCallback() {
    this.intersectionObserver?.disconnect();
  }

  /**
   * The indices of cells that have been rendered
   *
   * @private
   * @memberof InfiniteScroller
   */
  private renderedCellIndices = new Set<number>();

  /**
   * The indices of cells that are visible
   *
   * @private
   * @memberof InfiniteScroller
   */
  private visibleCellIndices = new Set<number>();

  /**
   * The indices of cells that have placeholders in them
   *
   * @private
   * @memberof InfiniteScroller
   */
  private placeholderCellIndices = new Set<number>();

  private resizeObserver?: ResizeObserver;

  private previousCellWidth?: number;

  /**
   * Add observations for all of the things that need observing
   *
   * @private
   * @memberof InfiniteScroller
   */
  private setupObservations() {
    this.setupIntersectionObserver();
    this.setupResizeObserver();
  }

  /**
   * The intersection observer is used to determine when cells are visible
   * so we can efficiently render only the minimum number of cells
   */
  private setupIntersectionObserver() {
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        // If we've reached the sentinel, emit a `scrollThresholdReached` event
        // and move on to the next entry. This is when the consumer should start
        // fetching more data.
        if (entry.target === this.sentinel) {
          if (entry.isIntersecting) {
            this.dispatchEvent(new Event('scrollThresholdReached'));
          }
          return;
        }

        // the rest of the entries are for individual tiles so
        // build up a set of visible cells to be processed
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

      // we only need to process visible cells if scroll optimizations are enabled
      if (!this.scrollOptimizationsDisabled) {
        this.processVisibleCells();
      }
    });

    // observe the sentinel
    // the sentinel is an optional because `reload()` can be called before
    // the DOM is ready so it may not be in the DOM yet
    // subsequent calls to `reload()` will re-observe the sentinel
    if (this.sentinel) this.intersectionObserver.observe(this.sentinel);

    // if scroll optimizations are disabled, just add all of the datasource
    // indices to the visibleCells and process them immediately,
    // otherwise add all of the cells to the intersection observer to optimize
    // the scrolling experience
    if (this.scrollOptimizationsDisabled) {
      const indexArray = generateRange(0, Math.max(0, this.itemCount - 1), 1);
      indexArray.forEach(index => this.visibleCellIndices.add(index));
      this.processVisibleCells();
    } else {
      // if scroll optimizations are enabled, observe all of the cell containers
      this.cellContainers.forEach(cell =>
        this.intersectionObserver?.observe(cell)
      );
    }
  }

  /**
   * The ResizeObserver observes the size of a single cell so we can update
   * a CSS variable to help with layout.
   *
   * For instance, to maintain a square aspect ratio of an image, we need to
   * know the width of the cell so we can set the height to the width.
   *
   * There is an `aspect-raio` CSS property, but it's very new and not widely supported.
   */
  private setupResizeObserver() {
    this.resizeObserver?.disconnect();

    if (this.cellContainers.length === 0) return;
    this.resizeObserver = new ResizeObserver(entries => {
      if (entries.length === 0) return;
      const entry = entries[0];
      const { width } = entry.contentRect;
      if (width === this.previousCellWidth) return;
      this.previousCellWidth = width;
      const event = new CustomEvent('cellWidthChanged', {
        detail: { width },
      });
      this.dispatchEvent(event);
    });
    this.resizeObserver.observe(this.cellContainers[0]);
  }

  render(): TemplateResult {
    const finalIndex = this.itemCount - 1;
    const indexArray = generateRange(0, finalIndex, 1);
    return html`
      <div id="container">
        <div id="sentinel"></div>
        ${repeat(
          indexArray,
          index => index,
          index => html`
            <div
              class="cell-container"
              data-cell-index=${index}
              @click=${(e: Event) => this.cellSelected(e, index)}
              @keyup=${(e: Event) => this.cellSelected(e, index)}
            ></div>
          `
        )}
      </div>
    `;
  }

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
   * After the IntersectionObserver processes all of the currently
   * viewable cells, we want to add a buffer on either side to help
   * with scroll performance.
   *
   * This methods calculates what cells need to be rendered based
   * on the currently visible cells and the size of the buffer.
   *
   * @private
   * @returns
   * @memberof InfiniteScroller
   */
  private processVisibleCells() {
    const visibleCellArray = Array.from(this.visibleCellIndices);
    const cellBufferSize = Math.max(10, visibleCellArray.length);
    const sortedVisibleRange = visibleCellArray.sort((a, b) =>
      a > b ? 1 : -1
    );
    // if there are no visible cells, use the first `cellBufferSize`
    const noVisibleCells = visibleCellArray.length === 0;
    const minIndex = noVisibleCells
      ? 0
      : Math.max(sortedVisibleRange[0] - cellBufferSize, 0);
    const maxIndex = noVisibleCells
      ? cellBufferSize
      : Math.min(
          sortedVisibleRange[sortedVisibleRange.length - 1] + cellBufferSize,
          this.itemCount - 1
        );
    const bufferRange = generateRange(minIndex, maxIndex, 1);
    this.renderCellBuffer(bufferRange);
    this.removeCellsOutsideBufferRange(bufferRange);

    const visibleCellsChangedEvent = new CustomEvent('visibleCellsChanged', {
      detail: {
        visibleCellIndices: visibleCellArray,
      },
    });
    this.dispatchEvent(visibleCellsChangedEvent);
  }

  /**
   * Render cells in the given buffer range
   *
   * @private
   * @param {number[]} bufferRange
   * @memberof InfiniteScroller
   */
  private renderCellBuffer(bufferRange: number[]) {
    bufferRange.forEach(index => {
      if (this.renderedCellIndices.has(index)) return;
      const cellContainer = this.shadowRoot?.querySelector(
        `.cell-container[data-cell-index="${index}"]`
      ) as HTMLDivElement;
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
   *
   * @private
   * @param {number[]} bufferRange
   * @memberof InfiniteScroller
   */
  private removeCellsOutsideBufferRange(bufferRange: number[]) {
    // get the rendered cells outside of the buffer range so we can remove them
    const renderedUnbufferedCells = Array.from(this.renderedCellIndices).filter(
      index => !bufferRange.includes(index)
    );
    renderedUnbufferedCells.forEach(index => {
      this.removeCell(index);
    });
  }

  private removeCell(index: number) {
    const cellContainer = this.shadowRoot?.querySelector(
      `.cell-container[data-cell-index="${index}"]`
    ) as HTMLDivElement;
    if (!cellContainer) return;
    render(nothing, cellContainer);
    this.renderedCellIndices.delete(index);
  }

  static get styles(): CSSResultGroup {
    const sentinelHeightCss = css`var(--infiniteScrollerSentinelDistanceFromEnd, 200rem)`;
    const cellGapSizeCss = css`var(--infiniteScrollerCellGap, 1.7rem)`;
    const cellMinWidth = css`var(--infiniteScrollerCellMinWidth, 10rem)`;
    const cellMaxWidth = css`var(--infiniteScrollerCellMaxWidth, 1fr)`;
    const cellMinHeight = css`var(--infiniteScrollerCellMinHeight, 10rem)`;
    const cellMaxHeight = css`var(--infiniteScrollerCellMaxHeight, unset)`;
    const cellOutline = css`var(--infiniteScrollerCellOutline, 0)`;

    return css`
      #container {
        position: relative;
        display: grid;
        gap: ${cellGapSizeCss};
        grid-template-columns: repeat(
          auto-fit,
          minmax(${cellMinWidth}, ${cellMaxWidth})
        );
        padding: 1rem;
        margin: auto;
      }

      .cell-container {
        outline: ${cellOutline};
        min-height: ${cellMinHeight};
        max-height: ${cellMaxHeight};
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
