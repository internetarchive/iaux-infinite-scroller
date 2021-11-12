import { css, html, LitElement } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('tile-2')
export class Tile2 extends LitElement {
  render() {
    return html`
      <h1>Tile2</h1>
      <h2><slot></slot></h2>
    `;
  }

  static get styles() {
    return css`
      :host {
        display: block;
        height: 100%;
        outline: 1px solid blue;
      }

      h1 {
        color: blue;
      }
    `;
  }
}
