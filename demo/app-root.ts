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

  private tileDesign: string = '1';

  private showTile(design: string) {
    this.tileDesign = design;
    this.infiniteScroller.reload();
  }

  cellForIndex(index: number): TemplateResult {
    console.debug('cellForIndex', index);
    if (this.tileDesign === '1') {
      return html`<tile-1>${index}</tile-1>`;
    }
    return html`<tile-2>${index}</tile-2>`;
  }

  render() {
    return html`
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

      <infinite-scroller .itemCount=${100} .cellProvider=${this}>
      </infinite-scroller>
    `;
  }

  static styles = css`
    :host {
      display: block;
    }

    .cell {
      outline: 1px solid green;
    }
  `;
}
