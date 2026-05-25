/**
 * Initial fallback height in pixels, used before any real cell measurements
 * are available. Picked to over-estimate (rather than under-estimate) since
 * an underestimated spacer produces a too-short scrollbar that the user
 * could scroll past.
 */
export const INITIAL_ROW_HEIGHT = 300;

/**
 * Encapsulates the cell- and row-height tracking and the height-fallback
 * chain used by the virtualized scroller. Owns five pieces of state:
 *
 *  - `cellHeights`: measured pixel heights of individual buffered cells
 *  - `rowHeights`: per-row maximum cell height (derived from `cellHeights`)
 *  - `placeholderRowHeight`: average height of pure-placeholder rows
 *  - `defaultRowHeight`: fallback estimate used when no measurement exists
 *  - `columnsPerRow`: needed to map between cell index and row index
 *
 * The fallback chain (`rowHeights[r] → placeholderRowHeight → defaultRowHeight`)
 * lives in exactly one place: `rowHeightFor()`. All other consumers go through
 * it, eliminating the previously-duplicated lookup in 5+ host call sites.
 *
 * The cache exposes its internal `Map`s through readonly getters so that
 * the host class's tests can still poke `(el as any).rowHeights.get(r)` and
 * `(el as any).cellHeights.size` directly without breaking. The returned
 * values ARE the live `Map` instances (typed as `ReadonlyMap`), so reads
 * always reflect current state.
 */
export class RowHeightCache {
  private _cellHeights = new Map<number, number>();

  private _rowHeights = new Map<number, number>();

  private _placeholderRowHeight: number | undefined;

  private _defaultRowHeight: number;

  private _columnsPerRow = 1;

  constructor(initialDefaultRowHeight: number = INITIAL_ROW_HEIGHT) {
    this._defaultRowHeight = initialDefaultRowHeight;
  }

  /**
   * Live readonly view of the per-cell height map. Mutations must go
   * through the cache's methods (`recordCellHeight`, `deleteCellHeight`,
   * `clear`, `pruneAtOrAbove`).
   */
  get cellHeights(): ReadonlyMap<number, number> {
    return this._cellHeights;
  }

  /**
   * Live readonly view of the per-row height map. Mutations must go
   * through `recordCellHeight`, `recalculateRowHeight`, `recalculateAllRowHeights`, or `clear`.
   */
  get rowHeights(): ReadonlyMap<number, number> {
    return this._rowHeights;
  }

  get columnsPerRow(): number {
    return this._columnsPerRow;
  }

  set columnsPerRow(n: number) {
    this._columnsPerRow = n;
  }

  get defaultRowHeight(): number {
    return this._defaultRowHeight;
  }

  set defaultRowHeight(h: number) {
    this._defaultRowHeight = h;
  }

  get placeholderRowHeight(): number | undefined {
    return this._placeholderRowHeight;
  }

  set placeholderRowHeight(h: number | undefined) {
    this._placeholderRowHeight = h;
  }

  /**
   * Single source of the height-fallback chain: prefer the measured row
   * height, fall back to the placeholder estimate, then to the default.
   * Every consumer of "what height should I assume for row r?" calls this.
   */
  rowHeightFor(row: number): number {
    return (
      this._rowHeights.get(row) ??
      this._placeholderRowHeight ??
      this._defaultRowHeight
    );
  }

  /**
   * Sums the (estimated or measured) heights of all rows in the inclusive
   * range `[startRow, endRow]`, plus the row gaps between them. Used to
   * compute both the total scroll-spacer height (sum across all rows) and
   * the buffer transform offset (sum across rows preceding the buffer's
   * first row). Returns 0 when the range is empty.
   */
  sumRowHeights(startRow: number, endRow: number, rowGap: number): number {
    if (endRow < startRow) return 0;
    let total = 0;
    for (let r = startRow; r <= endRow; r += 1) {
      total += this.rowHeightFor(r);
    }
    total += Math.max(0, endRow - startRow) * rowGap;
    return total;
  }

  /**
   * Records the measured height of a cell and recomputes its row's height
   * as the max over all measured cells in that row. We use max-over-cells
   * (not a monotone-up ratchet) so the row height shrinks back down when
   * a tall placeholder is replaced by shorter content.
   */
  recordCellHeight(cellIndex: number, height: number): void {
    this._cellHeights.set(cellIndex, height);
    this.recalculateRowHeight(Math.floor(cellIndex / this._columnsPerRow));
  }

  /**
   * Deletes the cellHeights entry for `cellIndex`. Returns true if the
   * entry was present. Callers decide whether to follow up with
   * `recalculateRowHeight()` or `recalculateAllRowHeights()` to reflect the deletion in the
   * row map.
   */
  deleteCellHeight(cellIndex: number): boolean {
    return this._cellHeights.delete(cellIndex);
  }

  /**
   * Recomputes the cached height for `row` as the max over currently
   * measured cells in that row. Removes the row entry if no cells in
   * that row are measured.
   */
  recalculateRowHeight(row: number): void {
    const cols = this._columnsPerRow;
    const firstCellInRow = row * cols;
    let maxHeight = 0;
    for (let c = 0; c < cols; c += 1) {
      const h = this._cellHeights.get(firstCellInRow + c);
      if (h !== undefined && h > maxHeight) maxHeight = h;
    }
    if (maxHeight > 0) {
      this._rowHeights.set(row, maxHeight);
    } else {
      this._rowHeights.delete(row);
    }
  }

  /**
   * Refreshes the heights of all rows, e.g., after a column-count change
   * or a resize that invalidates the existing row mapping.
   */
  recalculateAllRowHeights(): void {
    this._rowHeights.clear();
    const rowsToUpdate = new Set<number>();
    for (const cellIndex of this._cellHeights.keys()) {
      rowsToUpdate.add(Math.floor(cellIndex / this._columnsPerRow));
    }
    rowsToUpdate.forEach(r => this.recalculateRowHeight(r));
  }

  /**
   * Updates the default row height to match the average of all currently
   * measured rows. No-op if no rows have been measured yet.
   */
  recalculateDefaultRowHeight(): void {
    if (this._rowHeights.size === 0) return;
    let sum = 0;
    for (const h of this._rowHeights.values()) sum += h;
    this._defaultRowHeight = sum / this._rowHeights.size;
  }

  /**
   * Drops every `cellHeights` entry whose index is `>= cutoff`. Used to
   * clean up after `itemCount` shrinks. Caller is responsible for calling
   * `recalculateAllRowHeights()` afterward to reflect the dropped cells in the row
   * map.
   */
  pruneAtOrAbove(cutoff: number): void {
    for (const index of this._cellHeights.keys()) {
      if (index >= cutoff) this._cellHeights.delete(index);
    }
  }

  /**
   * Clears all measured state (cellHeights + rowHeights) and resets the
   * placeholder-row estimate. Default row height is preserved — it is set
   * separately, typically from `computeDefaultRowHeight()` on the host.
   */
  clear(): void {
    this._cellHeights.clear();
    this._rowHeights.clear();
    this._placeholderRowHeight = undefined;
  }
}
