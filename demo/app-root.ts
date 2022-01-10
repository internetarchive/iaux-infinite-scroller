import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import './tile-1';
import './tile-2';
import '../src/infinite-scroller';
import type {
  InfiniteScroller,
  InfiniteScrollerCellProviderInterface,
} from '../src/infinite-scroller';

export function promisedSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

@customElement('app-root')
export class AppRoot
  extends LitElement
  implements InfiniteScrollerCellProviderInterface
{
  @query('infinite-scroller') infiniteScroller!: InfiniteScroller;

  private tileDesign: '1' | '2' = '1';

  private showTile(design: '1' | '2') {
    this.tileDesign = design;
    this.infiniteScroller.reload();
  }

  private scrollThresholdReached() {
    this.infiniteScroller.itemCount += 50;
  }

  async cellForIndex(index: number): Promise<TemplateResult | undefined> {
    await promisedSleep(Math.random() * 2000);
    if (this.tileDesign === '1') {
      return html`<tile-1><p>${index}</p></tile-1>`;
    }
    return html`<tile-2><p>${index}</p></tile-2>`;
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
    }

    .cell {
      outline: 1px solid green;
    }

    infinite-scroller {
      --infiniteScrollerCellOutline: 1px solid green;
    }
  `;
}
