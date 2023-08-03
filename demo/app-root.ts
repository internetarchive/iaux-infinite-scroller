import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import './tile-1';
import './tile-2';
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

  private tileDesign: '1' | '2' = '1';

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

  cellForIndex(index: number): TemplateResult | undefined {
    if (this.tileDesign === '1') {
      return html`<tile-1>${index}</tile-1>`;
    }
    return html`<tile-2>${index}</tile-2>`;
  }

  render() {
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
        </div>
        <div>
          <form @submit=${this.scrollToCell}>
            Scroll to cell index:
            <input type="number" id="scrollToCellIndex" /> Animated:
            <input type="checkbox" id="animatedCheckbox" checked />
            <input type="submit" value="Scroll" />
          </form>
        </div>
      </div>

      <infinite-scroller
        .itemCount=${100}
        .cellProvider=${this}
        @scrollThresholdReached=${this.scrollThresholdReached}
      >
      </infinite-scroller>
    `;
  }

  static styles = css`
    :host {
      display: block;
      color: white;
      font-size: 1.6rem;
    }

    .cell {
      outline: 1px solid green;
    }

    #scrollToCellIndex {
      width: 50px;
    }

    infinite-scroller {
      --infiniteScrollerCellMinHeight: 1rem;
      --infiniteScrollerCellMaxHeight: 20rem;
    }
  `;
}
