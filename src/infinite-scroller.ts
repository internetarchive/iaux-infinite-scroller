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

  /**
   * The sentinel is our marker to know when we need to load more data
   *
   * @type {HTMLDivElement}
   * @memberof InfiniteScroller
   */
  @query('#sentinel') private sentinel?: HTMLDivElement;

  @queryAll('.cell-container') private cellContainers!: HTMLDivElement[];

  private intersectionObserver: IntersectionObserver = new IntersectionObserver(
    entries => {
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
    }
  );

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
  refreshCell(index: number): void {
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
    this.intersectionObserver.disconnect();
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

  /**
   * Add observations for all of the things that need observing
   *
   * @private
   * @memberof InfiniteScroller
   */
  private setupObservations() {
    this.setupIntersectionObserver();
  }

  /**
   * The intersection observer is used to determine when cells are visible
   * so we can efficiently render only the minimum number of cells
   */
  private setupIntersectionObserver() {
    this.intersectionObserver.disconnect();

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
        this.intersectionObserver.observe(cell)
      );
    }
  }

  render(): TemplateResult {
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
      </section>
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
   * An array of cell indices that need to be rendered based
   * on the currently visible cells and the size of the buffer.
   */
  private get bufferRange(): number[] {
    const cellBufferSize = Math.max(10, this.visibleCellIndices.size);

    // if there are no visible cells, use the first `cellBufferSize`
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
    const { bufferRange } = this;
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
      const cellContainer = this.cellContainerForIndex(index);
      if (!cellContainer) return;
      const template = this.cellProvider?.cellForIndex(index);
      // When a cell is visible, the height should be auto-calculated.
      // When we remove the cell below, the height gets fixed to the last known size
      // so the scroll doesn't jump around.
      cellContainer.style.height = 'auto';
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
    const cellContainer = this.cellContainerForIndex(index);
    if (!cellContainer) return;
    // just before we remove the contents of the cell, we want to hardcode the height
    // so the scroll doesn't jump around when the cell shrinks due to content removal
    const height = cellContainer.offsetHeight;
    cellContainer.style.height = `${height}px`;
    render(nothing, cellContainer);
    this.renderedCellIndices.delete(index);
  }

  private cellContainerForIndex(index: number): HTMLDivElement | null {
    return this.shadowRoot?.querySelector(
      `.cell-container[data-cell-index="${index}"]`
    ) as HTMLDivElement;
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
