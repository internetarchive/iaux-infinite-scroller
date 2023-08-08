/* eslint-disable import/no-duplicates */
import { expect, fixture, oneEvent } from '@open-wc/testing';
import { html, TemplateResult } from 'lit';
import {
  CellSelectionDetails,
  InfiniteScroller,
  InfiniteScrollerCellProviderInterface,
} from '../src/infinite-scroller';
import '../src/infinite-scroller';
import { promisedSleep } from './promised-sleep';

describe('Infinite Scroller', () => {
  it('should render with a sentinel and number of cells', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${3}></infinite-scroller>`
    );

    const sentinel = el.shadowRoot?.querySelector('#sentinel');
    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(sentinel).to.exist;
    expect(cells?.length).to.equal(3);
  });

  it('emits a cellSelected event when a tile is clicked', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${3}></infinite-scroller>`
    );
    const cell = el.shadowRoot?.querySelector('.cell-container');

    const clickEvent = new MouseEvent('click');
    setTimeout(() => {
      cell?.dispatchEvent(clickEvent);
    });
    const event: CustomEvent<CellSelectionDetails> = await oneEvent(
      el,
      'cellSelected'
    );
    expect(event).to.exist;
    expect(event.detail.index).to.equal(0);
    expect(event.detail.originalEvent).to.exist;
  });

  it('populates cell containers with provided content', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html` cell-${index} `,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${3}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );
    const cells = el.shadowRoot?.querySelectorAll('.cell-container');

    // wait for the cells to be populated
    await promisedSleep(100);
    expect(cells?.length).to.equal(3);
    expect((cells?.[0] as HTMLDivElement).innerText).to.equal('cell-0');
    expect((cells?.[1] as HTMLDivElement).innerText).to.equal('cell-1');
    expect((cells?.[2] as HTMLDivElement).innerText).to.equal('cell-2');
  });

  it('refreshes specific cell content when requested', async () => {
    const cellData = ['foo', 'bar', 'baz'];
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`cell-${index} ${cellData[index]}`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${3}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );
    const cells = el.shadowRoot?.querySelectorAll('.cell-container');

    // wait for the cells to be populated
    await promisedSleep(100);
    expect(cells?.length).to.equal(3);

    cellData.splice(0, 3, 'a', 'b', 'c');
    el.refreshCell(1);
    await el.updateComplete;

    expect((cells?.[0] as HTMLDivElement).innerText).to.equal('cell-0 foo');
    expect((cells?.[1] as HTMLDivElement).innerText).to.equal('cell-1 b');
    expect((cells?.[2] as HTMLDivElement).innerText).to.equal('cell-2 baz');
  });

  it('refreshes all visible cell content when requested', async () => {
    const cellData = ['foo', 'bar', 'baz'];
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`cell-${index} ${cellData[index]}`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${3}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );
    const cells = el.shadowRoot?.querySelectorAll('.cell-container');

    // wait for the cells to be populated
    await promisedSleep(100);
    expect(cells?.length).to.equal(3);

    cellData.splice(0, 3, 'a', 'b', 'c');
    el.refreshAllVisibleCells();
    await el.updateComplete;

    expect((cells?.[0] as HTMLDivElement).innerText).to.equal('cell-0 a');
    expect((cells?.[1] as HTMLDivElement).innerText).to.equal('cell-1 b');
    expect((cells?.[2] as HTMLDivElement).innerText).to.equal('cell-2 c');
  });
});
