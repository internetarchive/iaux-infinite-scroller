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

/**
 * Helper: wait for one animation frame + a microtask, matching the timing
 * used by scheduleSentinelRecheck (updateComplete → rAF).
 */
function waitForFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

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

    await el.bufferStabilized;
    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
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

    await el.bufferStabilized;
    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
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

    await el.bufferStabilized;
    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cells?.length).to.equal(3);

    cellData.splice(0, 3, 'a', 'b', 'c');
    el.refreshAllVisibleCells();
    await el.updateComplete;

    expect((cells?.[0] as HTMLDivElement).innerText).to.equal('cell-0 a');
    expect((cells?.[1] as HTMLDivElement).innerText).to.equal('cell-1 b');
    expect((cells?.[2] as HTMLDivElement).innerText).to.equal('cell-2 c');
  });

  it('updates buffered region when itemCount increases in non-virtualized mode', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${5}
        .cellProvider=${cellProvider}
        scrollOptimizationsDisabled
      ></infinite-scroller>`
    );

    const cellsBefore = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cellsBefore?.length).to.equal(5);

    el.itemCount = 10;
    await el.updateComplete;

    const cellsAfter = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cellsAfter?.length).to.equal(10);
  });
});

describe('Infinite Scroller Virtualization', () => {
  afterEach(() => {
    window.scrollTo(0, 0);
  });

  it('renders fewer DOM elements than itemCount for large lists', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cells?.length).to.be.lessThan(1000);
    expect(cells?.length).to.be.greaterThan(0);
  });

  it('renders scroll-spacer and transformed container in virtualized mode', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${1000}></infinite-scroller>`
    );

    await el.bufferStabilized;

    const scrollSpacer = el.shadowRoot?.querySelector(
      '#scroll-spacer'
    ) as HTMLElement;
    const container = el.shadowRoot?.querySelector('#container') as HTMLElement;
    expect(scrollSpacer).to.exist;
    expect(container).to.exist;
    expect(parseFloat(scrollSpacer.style.height)).to.be.greaterThan(0);
    expect(container.style.transform).to.equal('translateY(0px)');
  });

  it('scrollToCell returns true when given a valid cell index', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    const result = await el.scrollToCell(500, false);
    expect(result).to.be.true;
  });

  it('scrollToCell places target cell in DOM for far-away indices', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    const result = await el.scrollToCell(500, false);
    expect(result).to.be.true;

    const targetCell = el.shadowRoot?.querySelector(
      '.cell-container[data-cell-index="500"]'
    );
    expect(targetCell).to.exist;
    expect(targetCell?.textContent).to.equal('cell-500');
  });

  it('scrollToCell returns false when index is out of bounds', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${1000}></infinite-scroller>`
    );

    await el.bufferStabilized;

    expect(await el.scrollToCell(-1, false)).to.be.false;
    expect(await el.scrollToCell(1000, false)).to.be.false;
  });

  it('renders all cells immediately when scrollOptimizationsDisabled is true', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${50}
        scrollOptimizationsDisabled
      ></infinite-scroller>`
    );

    await el.updateComplete;

    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cells?.length).to.equal(50);

    // No scroll-spacer or struts should be present when scroll optimization is disabled
    const scrollSpacer = el.shadowRoot?.querySelector('#scroll-spacer');
    expect(scrollSpacer).to.not.exist;
  });

  it('sets correct aria set attributes on buffered cells', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${1000}></infinite-scroller>`
    );

    await el.bufferStabilized;

    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    if (cells && cells.length > 0) {
      const firstCell = cells[0];
      const posinset = firstCell.getAttribute('aria-posinset');
      const setsize = firstCell.getAttribute('aria-setsize');
      expect(posinset).to.exist;
      expect(setsize).to.equal('1000');
      expect(Number(posinset)).to.be.greaterThan(0);
    }
  });

  it('updates aria-setsize when itemCount increases', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    let firstCell = el.shadowRoot?.querySelector('.cell-container');
    expect(firstCell?.getAttribute('aria-setsize')).to.equal('1000');

    el.itemCount = 2000;
    await el.updateComplete;

    // Should reflect the new itemCount
    firstCell = el.shadowRoot?.querySelector('.cell-container');
    expect(firstCell?.getAttribute('aria-setsize')).to.equal('2000');
  });

  it('has correct data-cell-index attributes on buffered cells', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${1000}></infinite-scroller>`
    );

    await el.bufferStabilized;

    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    if (cells && cells.length > 0) {
      const firstCell = cells[0] as HTMLElement;
      expect(firstCell.dataset.cellIndex).to.equal('0');
    }
  });

  it('populates cell content in virtualized mode', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`cell-${index}`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cells?.length).to.be.greaterThan(0);
    const firstCell = cells?.[0] as HTMLDivElement;
    expect(firstCell.textContent).to.equal('cell-0');
  });

  it('can refresh a specific cell in virtualized mode', async () => {
    const cellContent = new Map<number, string>();
    for (let i = 0; i < 1000; i += 1) {
      cellContent.set(i, `foo-${i}`);
    }

    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`${cellContent.get(index)}`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    const firstCell = el.shadowRoot?.querySelector(
      '.cell-container[data-cell-index="0"]'
    ) as HTMLDivElement;
    expect(firstCell).to.exist;
    expect(firstCell.textContent).to.equal('foo-0');

    // Update cell contents but only refresh cell 0
    cellContent.set(0, 'bar-0');
    cellContent.set(1, 'bar-1');
    el.refreshCell(0);
    await el.updateComplete;

    expect(firstCell.textContent).to.equal('bar-0');

    // Other cells should be unchanged
    const secondCell = el.shadowRoot?.querySelector(
      '.cell-container[data-cell-index="1"]'
    ) as HTMLDivElement;
    expect(secondCell.textContent).to.equal('foo-1');
  });

  it('can refresh all visible cells in virtualized mode', async () => {
    const cellData = new Map<number, string>();
    for (let i = 0; i < 1000; i += 1) {
      cellData.set(i, `foo-${i}`);
    }
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`${cellData.get(index)}`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    // New cell data
    for (let i = 0; i < 1000; i += 1) {
      cellData.set(i, `bar-${i}`);
    }

    el.refreshAllVisibleCells();
    await el.updateComplete;

    // All buffered cells should have updated content
    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    if (cells && cells.length > 0) {
      const firstCell = cells[0] as HTMLDivElement;
      expect(firstCell.textContent).to.equal(`bar-0`);

      const tenthCell = cells[9] as HTMLDivElement;
      expect(tenthCell.textContent).to.equal(`bar-9`);
    }
  });

  it('emits cellSelected event when cells are clicked', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${1000}></infinite-scroller>`
    );

    await el.bufferStabilized;

    const cell = el.shadowRoot?.querySelector('.cell-container');
    expect(cell).to.exist;

    setTimeout(() => {
      cell!.dispatchEvent(new MouseEvent('click'));
    }, 0);

    const event: CustomEvent<CellSelectionDetails> = await oneEvent(
      el,
      'cellSelected'
    );
    expect(event?.detail?.index).to.equal(0);
  });

  it('has non-zero spacer height when buffer does not cover all rows', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${1000}></infinite-scroller>`
    );

    await el.bufferStabilized;

    const scrollSpacer = el.shadowRoot?.querySelector(
      '#scroll-spacer'
    ) as HTMLElement;
    expect(scrollSpacer).to.exist;
    expect(parseFloat(scrollSpacer.style.height)).to.be.greaterThan(0);
  });

  it('has zero buffer offset when buffer starts at index 0', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${1000}></infinite-scroller>`
    );

    await el.bufferStabilized;

    const container = el.shadowRoot?.querySelector('#container') as HTMLElement;
    expect(container.style.transform).to.equal('translateY(0px)');
  });

  it('renders all cells with zero offset when all items fit in buffer', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${5}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cells?.length).to.equal(5);

    const scrollSpacer = el.shadowRoot?.querySelector(
      '#scroll-spacer'
    ) as HTMLElement;
    const container = el.shadowRoot?.querySelector('#container') as HTMLElement;
    expect(parseFloat(scrollSpacer.style.height)).to.be.greaterThan(0);
    expect(container.style.transform).to.equal('translateY(0px)');
  });

  it('does not render cells beyond itemCount', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${200}></infinite-scroller>`
    );

    await el.bufferStabilized;

    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cells).to.exist;
    for (let i = 0; i < cells!.length; i += 1) {
      const cell = cells![i] as HTMLElement;
      const idx = Number(cell.dataset.cellIndex);
      expect(idx).to.be.at.least(0);
      expect(idx).to.be.lessThan(200);
    }
  });

  it('clears cells and resets scroll geometry after reload', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    let cells = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cells?.length).to.be.greaterThan(0);

    el.reload();
    await el.bufferStabilized;

    // After reload, cells should be re-rendered (not empty)
    cells = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cells?.length).to.be.greaterThan(0);

    // Buffer offset should be 0 since buffer starts at 0 after reload
    const container = el.shadowRoot?.querySelector('#container') as HTMLElement;
    expect(container.style.transform).to.equal('translateY(0px)');
  });

  it('getVisibleCellIndices returns an array of indices for all cells in the viewport', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    const visible = el.getVisibleCellIndices();
    expect(visible).to.be.an('array');
    for (const idx of visible) {
      expect(idx).to.be.at.least(0);
      expect(idx).to.be.lessThan(500); // Surely no more than half are in the viewport?
    }
  });

  it('bufferMultiplier defaults to 1 and is configurable', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    expect(el.bufferMultiplier).to.equal(1);

    el.bufferMultiplier = 3;
    expect(el.bufferMultiplier).to.equal(3);
  });

  it('respects bufferSize as minimum floor when bufferMultiplier is 0', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
        .bufferMultiplier=${0}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    // With multiplier=0, the minimum floor (bufferSize=10) should still apply
    // so we should have at least some cells rendered
    expect(cells?.length).to.be.at.least(10);
  });

  it('clears stale height when refreshCell replaces placeholder with content', async () => {
    // Return undefined (placeholder) for the first cell, and real content for the rest
    let returnContent = false;
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined => {
        if (index === 0 && !returnContent) return undefined;
        return html`<div style="height:50px">cell-${index}</div>`;
      },
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${5}
        .cellProvider=${cellProvider}
        .placeholderCellTemplate=${html`<div style="height:20px">loading</div>`}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    // First cell should have placeholder content
    const firstCell = el.shadowRoot?.querySelector(
      '.cell-container[data-cell-index="0"]'
    ) as HTMLDivElement;
    expect(firstCell).to.exist;
    expect(firstCell.textContent).to.contain('loading');

    // Return real content for first cell now too
    returnContent = true;
    el.refreshCell(0);
    await el.updateComplete;

    // Cell 0 should now have real content
    expect(firstCell.textContent).to.contain('cell-0');
  });

  it('buffer does not skip cell indices within its range (all contiguous)', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${1000}></infinite-scroller>`
    );

    await el.bufferStabilized;

    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    if (cells && cells.length > 1) {
      const indices: number[] = [];
      cells.forEach(cell => {
        indices.push(parseInt((cell as HTMLElement).dataset.cellIndex!, 10));
      });
      // Indices should be sorted and contiguous
      for (let i = 1; i < indices.length; i += 1) {
        expect(indices[i]).to.equal(indices[i - 1] + 1);
      }
    }
  });
});

describe('scrollThresholdReached sentinel behavior', () => {
  afterEach(() => {
    window.scrollTo(0, 0);
  });

  it('fires scrollThresholdReached when sentinel is visible', async () => {
    // When itemCount is small, the sentinel is initially already in the viewport,
    // so the event should fire immediately.
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${5}></infinite-scroller>`
    );

    await el.bufferStabilized;

    let eventCount = 0;
    el.addEventListener('scrollThresholdReached', () => {
      eventCount += 1;
    });

    await promisedSleep(200);
    expect(eventCount).to.equal(1);
  });

  it('fires scrollThresholdReached again after itemCount increases', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${5}></infinite-scroller>`
    );

    await el.bufferStabilized;

    let eventCount = 0;
    el.addEventListener('scrollThresholdReached', () => {
      eventCount += 1;
    });

    // Initial event
    await promisedSleep(100);
    expect(eventCount).to.equal(1);

    // Increasing the itemCount causes the sentinel to fire the event again
    el.itemCount = 10;
    await el.updateComplete;
    await waitForFrame();
    await promisedSleep(100);

    expect(eventCount).to.equal(2);
  });

  it('does not rapid-fire when itemCount changes multiple times quickly', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${5}></infinite-scroller>`
    );

    await el.bufferStabilized;

    let eventCount = 0;
    el.addEventListener('scrollThresholdReached', () => {
      eventCount += 1;
    });

    // Initial event
    await promisedSleep(100);
    const initialCount = eventCount;

    // Rapidly increase itemCount several times, as if the user is hovering at the end
    // of the buffer continuously
    const numIterations = 10;
    for (let i = 0; i < numIterations; i += 1) {
      el.itemCount += 10;
      // eslint-disable-next-line no-await-in-loop
      await el.updateComplete;
    }

    // Wait for all pending sentinel rechecks to settle
    await waitForFrame();
    await promisedSleep(200);

    // Should have fired at most one additional event per itemCount change
    expect(eventCount).to.be.lessThanOrEqual(initialCount + numIterations);
  });

  it('resets sentinel pending state after reload', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${5}></infinite-scroller>`
    );

    await el.bufferStabilized;

    let eventCount = 0;
    el.addEventListener('scrollThresholdReached', () => {
      eventCount += 1;
    });

    await promisedSleep(100);
    expect(eventCount).to.equal(1);

    // Reload should reset all sentinel state
    el.reload();
    await el.bufferStabilized;
    await promisedSleep(100);

    // Sentinel should be able to fire again after reload
    expect(eventCount).to.be.greaterThan(1);
  });
});

describe('Scroll geometry and placeholder edge cases', () => {
  afterEach(() => {
    window.scrollTo(0, 0);
  });

  it('spacer height increases when itemCount grows', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${1000}></infinite-scroller>`
    );

    await el.bufferStabilized;

    const scrollSpacer = el.shadowRoot?.querySelector(
      '#scroll-spacer'
    ) as HTMLElement;
    const initialHeight = parseFloat(scrollSpacer.style.height);
    expect(initialHeight).to.be.greaterThan(0);

    // If we double the item count, the spacer should grow
    el.itemCount = 2000;
    await el.updateComplete;

    const newHeight = parseFloat(scrollSpacer.style.height);
    expect(newHeight).to.be.greaterThan(initialHeight);
  });

  it('all buffered placeholder cells render the placeholder template', async () => {
    // Provider that returns undefined for everything → all placeholders
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (): TemplateResult | undefined => undefined,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${20}
        .cellProvider=${cellProvider}
        .placeholderCellTemplate=${html`<div class="placeholder">loading</div>`}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    const cells = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cells?.length).to.be.greaterThan(0);
    cells?.forEach(cell => {
      const placeholder = cell.querySelector('.placeholder');
      expect(placeholder).to.exist;
      expect(placeholder!.textContent).to.equal('loading');
    });
  });

  it('cells correctly render placeholders after reload', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (): TemplateResult | undefined => undefined,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${5}
        .cellProvider=${cellProvider}
        .placeholderCellTemplate=${html`<div class="ph">placeholder</div>`}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    let cells = el.shadowRoot?.querySelectorAll('.cell-container');
    cells?.forEach(cell => {
      expect(cell.querySelector('.ph')).to.exist;
    });

    el.reload();
    await el.bufferStabilized;

    // All cells should still have placeholder content
    cells = el.shadowRoot?.querySelectorAll('.cell-container');
    expect(cells?.length).to.be.greaterThan(0);
    cells?.forEach(cell => {
      expect(cell.querySelector('.ph')).to.exist;
    });
  });

  it('spacer height covers all content and offset is zero when all items fit', async () => {
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller .itemCount=${3}></infinite-scroller>`
    );

    await el.bufferStabilized;

    const scrollSpacer = el.shadowRoot?.querySelector(
      '#scroll-spacer'
    ) as HTMLElement;
    const container = el.shadowRoot?.querySelector('#container') as HTMLElement;
    expect(parseFloat(scrollSpacer.style.height)).to.be.greaterThan(0);
    expect(container.style.transform).to.equal('translateY(0px)');
  });
});

describe('Buffer multiplier and estimatedCellHeight', () => {
  it('higher bufferMultiplier produces a larger initial buffer', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };

    // With multiplier=0, only bufferSize floor applies
    const elSmall = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${10000}
        .cellProvider=${cellProvider}
        .bufferMultiplier=${0}
      ></infinite-scroller>`
    );
    // Read the initial buffer size before stabilization settles
    await elSmall.updateComplete;
    const smallCount =
      elSmall.shadowRoot?.querySelectorAll('.cell-container').length ?? 0;

    const elLarge = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${10000}
        .cellProvider=${cellProvider}
        .bufferMultiplier=${3}
      ></infinite-scroller>`
    );
    await elLarge.updateComplete;
    const largeCount =
      elLarge.shadowRoot?.querySelectorAll('.cell-container').length ?? 0;

    // With multiplier=3, the initial buffer should be larger than with 0
    expect(largeCount).to.be.greaterThan(smallCount);
  });

  it('estimatedCellHeight affects spacer height before stabilization', async () => {
    // Use a very large estimated height vs a small one to see the difference
    // in how the initial geometry is computed (before measured heights take over)
    const elTall = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${100}
        .estimatedCellHeight=${500}
      ></infinite-scroller>`
    );
    // Read spacer height right after first render, before stabilization completes
    await elTall.updateComplete;
    const tallSpacer = elTall.shadowRoot?.querySelector(
      '#scroll-spacer'
    ) as HTMLElement;
    const tallHeight = parseFloat(tallSpacer.style.height);

    const elShort = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${100}
        .estimatedCellHeight=${50}
      ></infinite-scroller>`
    );
    await elShort.updateComplete;
    const shortSpacer = elShort.shadowRoot?.querySelector(
      '#scroll-spacer'
    ) as HTMLElement;
    const shortHeight = parseFloat(shortSpacer.style.height);

    // Taller estimate should produce a taller spacer
    expect(tallHeight).to.be.greaterThan(shortHeight);
    expect(shortHeight).to.be.greaterThan(0);
  });
});

describe('scrollToCell animated and lifecycle', () => {
  it('scrollToCell with animated=true returns true for valid index', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${1000}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    const result = await el.scrollToCell(500, true);
    expect(result).to.be.true;
  });

  it('survives disconnect and reconnect without errors', async () => {
    const cellProvider: InfiniteScrollerCellProviderInterface = {
      cellForIndex: (index: number): TemplateResult | undefined =>
        html`<div>cell-${index}</div>`,
    };
    const el = await fixture<InfiniteScroller>(
      html`<infinite-scroller
        .itemCount=${100}
        .cellProvider=${cellProvider}
      ></infinite-scroller>`
    );

    await el.bufferStabilized;

    const cellsBefore =
      el.shadowRoot?.querySelectorAll('.cell-container').length ?? 0;
    expect(cellsBefore).to.be.greaterThan(0);

    // Remove from DOM (triggers disconnectedCallback)
    const parent = el.parentElement!;
    parent.removeChild(el);

    // Wait a tick to let any pending rAFs/timers fire
    await promisedSleep(50);

    // Re-append (triggers connectedCallback)
    parent.appendChild(el);
    await el.updateComplete;
    await promisedSleep(50);

    // Should still have rendered cells
    const cellsAfter =
      el.shadowRoot?.querySelectorAll('.cell-container').length ?? 0;
    expect(cellsAfter).to.be.greaterThan(0);
  });
});
