![Build Status](https://github.com/internetarchive/iaux-infinite-scroller/actions/workflows/ci.yml/badge.svg)

# Internet Archive Infinite Scroller

This is an infinite scroller web component, created with Lit. It detects when the user scrolls near the bottom to allow the consumer to fetch more data. It makes efficient use of browser resources by removing cells that are offscreen and loading a buffer of around either end of the visible cells to to preload cells before scrolling them into view.

## Usage

```ts
// Have your component or a standalone datasource object
// implement the `InfiniteScrollerCellProviderInterface`,
// which has 1 method: `cellForIndex(index: number): TemplateResult | undefined`
class MyElement extends LitElement implements InfiniteScrollerCellProviderInterface {
  // infinite-scroller will call your method when it needs a cell at a given index
  cellForIndex(index: number): TemplateResult | undefined {
    const useTile1 = Math.random() < 0.5;
    if (useTile1) {
      return html`<tile-1>${index}</tile-1>`;
    } else {
      return html`<tile-2>${index}</tile-2>`;
    }
  }

  // when the user has scrolled to a certain point, it will emit a
  // `scrollThresholdReached` event, at which point you can fetch
  // more data and increase the `itemCount`
  scrollThresholdReached() {
    this.infiniteScroller.itemCount += 50;
  }

  // using infinite-scroller:
  // - `itemCount`: update this value when you want to display more data
  // - `cellProvider`: the data source for the cells that will have `cellForIndex(index:number)`
  // - `placeholderCell`: provide it a custom placeholder cell if you'd like
  // - `@scrollThresholdReached`: a listener for when the user nears the bottom to fetch more
  render() {
    return html`
      <infinite-scroller
        .itemCount=${100}
        .cellProvider=${this}
        .placeholderCellTemplate=${html`
          <my-placeholder-cell></my-placeholder-cell>
        `}
        @scrollThresholdReached=${this.scrollThresholdReached}
      >
      </infinite-scroller>
    `
  }
}
```

## Local Demo with `web-dev-server`
```bash
yarn start
```
To run a local development server that serves the basic demo located in `demo/index.html`

## Testing with Web Test Runner
To run the suite of Web Test Runner tests, run
```bash
yarn run test
```

To run the tests in watch mode (for &lt;abbr title=&#34;test driven development&#34;&gt;TDD&lt;/abbr&gt;, for example), run

```bash
yarn run test:watch
```

## Linting with ESLint, Prettier, and Types
To scan the project for linting errors, run
```bash
yarn run lint
```

You can lint with ESLint and Prettier individually as well
```bash
yarn run lint:eslint
```
```bash
yarn run lint:prettier
```

To automatically fix many linting errors, run
```bash
yarn run format
```

You can format using ESLint and Prettier individually as well
```bash
yarn run format:eslint
```
```bash
yarn run format:prettier
```

## Tooling configs

For most of the tools, the configuration is in the `package.json` to reduce the amount of files in your project.

If you customize the configuration a lot, you can consider moving them to individual files.
