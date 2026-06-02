import { css, html, LitElement } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('placeholder-tile')
export class PlaceholderTile extends LitElement {
  render() {
    return html`
      <h1>...</h1>
      <h2><slot></slot></h2>
    `;
  }

  static get styles() {
    return css`
      :host {
        display: flex;
        justify-content: center;
        align-items: center;
        outline: 1px solid #aaa;
        height: 100%;
      }

      ::slotted(*) {
        color: #aaa;
      }

      h1 {
        color: #aaa;
        margin-top: 0;
      }
    `;
  }
}
