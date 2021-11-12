import { css, html, LitElement } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('tile-1')
export class Tile1 extends LitElement {
  render() {
    return html`
      <h1>Tile1</h1>
      <h2><slot></slot></h2>
    `;
  }

  static get styles() {
    return css`
      :host {
        display: block;
        outline: 1px solid red;
        height: 100%;
      }

      h1 {
        color: red;
      }
    `;
  }
}
