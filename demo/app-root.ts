import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import './tile-1';
import './tile-2';
import './placeholder-tile';
import '../src/infinite-scroller';
import type {
  InfiniteScroller,
  InfiniteScrollerCellProviderInterface,
} from '../src/infinite-scroller';

@customElement('app-root')
export class AppRoot
  extends LitElement
  implements InfiniteScrollerCellProviderInterface
{
  @query('infinite-scroller') infiniteScroller!: InfiniteScroller;

  @query('#scrollToCellIndex') scrollToInput!: HTMLInputElement;

  @query('#animatedCheckbox') animatedCheckbox!: HTMLInputElement;

  @query('#placeholdersCheckbox') placeholdersCheckbox!: HTMLInputElement;

  /**
   * Whether to nest the infinite scroller in a parent container with overflow: auto.
   * Default is false (using the main document scroll container).
   */
  @state() private useNestedScroller = false;

  private tileDesign: '1' | '2' = '1';

  private loadedCells = new Set();

  /**
   * Indices that have a pending placeholder-replacement timer queued, just
   * so we don't make extra setTimeout calls on them.
   */
  private pendingCells = new Set<number>();

  private showTile(design: '1' | '2') {
    this.tileDesign = design;
    this.infiniteScroller.refreshAllVisibleCells();
  }

  private scrollThresholdReached() {
    this.infiniteScroller.itemCount += 50;
  }

  private scrollToCell(e: Event) {
    e.preventDefault();
    const index = parseInt(this.scrollToInput.value, 10);
    const animated = this.animatedCheckbox.checked;
    if (index >= 0) {
      this.infiniteScroller.scrollToCell(index, animated);
    }
  }

  private toggleUseNestedScroller(e: Event) {
    this.useNestedScroller = (e.target as HTMLInputElement).checked;
  }

  private startPlaceholderTimer(index: number): void {
    this.pendingCells.add(index);
    setTimeout(() => {
      this.pendingCells.delete(index);
      if (!this.loadedCells.has(index)) {
        this.loadedCells.add(index);
        this.infiniteScroller.refreshCell(index);
      }
    }, 1000);
  }

  cellForIndex(index: number): TemplateResult | undefined {
    const usingPlaceholders = this.placeholdersCheckbox.checked;
    if (usingPlaceholders && !this.loadedCells.has(index)) {
      if (this.pendingCells.has(index)) return undefined;
      this.startPlaceholderTimer(index);
      return undefined;
    }

    if (this.tileDesign === '1') {
      return html`<tile-1>${index}</tile-1>`;
    }
    return html`<tile-2>${index}</tile-2>`;
  }

  get placeholderTemplate(): TemplateResult {
    return html`<placeholder-tile></placeholder-tile>`;
  }

  private scrollerTemplate(): TemplateResult {
    return html`
      <infinite-scroller
        .itemCount=${5000}
        .estimatedCellHeight=${80}
        .cellProvider=${this}
        .placeholderCellTemplate=${this.placeholderTemplate}
        @scrollThresholdReached=${this.scrollThresholdReached}
      >
      </infinite-scroller>
    `;
  }

  render() {
    const scroller = this.scrollerTemplate();
    return html`
      <div id="dev-tools">
        <div>
          Tile Style:
          <button
            @click=${() => {
              this.showTile('1');
            }}
          >
            Tile 1
          </button>
          <button
            @click=${() => {
              this.showTile('2');
            }}
          >
            Tile 2
          </button>
          <label>
            Placeholders:
            <input type="checkbox" id="placeholdersCheckbox" checked />
          </label>
          <label>
            Nested scroller:
            <input
              type="checkbox"
              id="nestedScrollerCheckbox"
              ?checked=${this.useNestedScroller}
              @change=${this.toggleUseNestedScroller}
            />
          </label>
        </div>
        <hr />
        <div>
          <form @submit=${this.scrollToCell}>
            Scroll to cell index:
            <input type="number" id="scrollToCellIndex" />
            <label
              >Animated: <input type="checkbox" id="animatedCheckbox"
            /></label>
            <input type="submit" value="Scroll" />
          </form>
        </div>
      </div>

      ${this.useNestedScroller
        ? html`<div class="nested-scroll-container">${scroller}</div>`
        : scroller}
    `;
  }

  static styles = css`
    :host {
      display: block;
      color: white;
      font-size: 1.6rem;
    }

    hr {
      border-color: #333;
    }

    #dev-tools {
      margin-bottom: 10px;
    }

    #dev-tools > div {
      margin: 5px 0;
    }

    button:last-of-type,
    input[type='checkbox'],
    input[type='number'] {
      margin-right: 10px;
    }

    .cell {
      outline: 1px solid green;
    }

    #scrollToCellIndex {
      width: 50px;
    }

    .nested-scroll-container {
      height: 600px;
      overflow-y: auto;
      border: 2px solid #888;
      padding: 0 10px;
    }

    infinite-scroller {
      --infiniteScrollerCellMinHeight: 1rem;
      --infiniteScrollerCellMaxHeight: 20rem;
    }
  `;
}
