/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

// A scroll window that paints only the items on screen, for the lists whose length is the GM's
// library rather than anything this module controls.
//
// Measured in v14.367 on a 1534-track playlist and a 1532-pad soundboard: rendered whole they are
// 12,309 and 21,477 DOM elements, and building them was most of what made opening the console take
// seconds. Painted through here they are a screenful each, and the cost stops following the size of
// the container.
//
// The three elements it drives are the same shape the library table uses (library.hbs):
//
//   scroll   overflow-y: auto — the only thing that actually scrolls
//     spacer height = every row, so the scrollbar is the true size of the list
//       window translated down to the first painted row; holds the painted items and nothing else
//
// Items must all be the same height, and in a grid the same width too — the whole mechanism is
// arithmetic on a constant pitch. `metrics()` is asked for that pitch on every paint rather than
// once at construction, which is what lets the pad grid resize its tiles under a window drag
// without this class knowing anything about it.
//
// The library table predates this and still has its own copy of the same arithmetic. It is not
// duplication worth removing yet: that one also carries a folder tree, roving keyboard focus and
// per-row file checks, and a shared abstraction that had to serve both would be a worse thing than
// two small ones.

export class VirtualList {
  /**
   * @param {object} config
   * @param {HTMLElement} config.scrollEl The scrolling element.
   * @param {HTMLElement} config.spacerEl Sized to the full list height; never scrolls itself.
   * @param {HTMLElement} config.windowEl Holds the painted items; translated into view.
   * @param {() => {rowHeight: number, columns?: number}} config.metrics Row pitch in pixels
   *   (including any gap) and how many items share a row. Read fresh on every paint.
   * @param {(start: number, end: number) => string} config.render The HTML for items `[start, end)`.
   * @param {() => void} [config.onPainted] Runs after every paint, for whatever has to follow the
   *   items that just appeared — reading a duration, checking a file is still there. It is the only
   *   hook a caller gets into a scroll-driven repaint, which nothing else can observe.
   * @param {number} [config.buffer] Rows painted above and below the window, so a fast scroll does
   *   not expose blank space before the next frame lands.
   */
  constructor({ scrollEl, spacerEl, windowEl, metrics, render, onPainted = null, buffer = 4 }) {
    this.#scrollEl = scrollEl;
    this.#spacerEl = spacerEl;
    this.#windowEl = windowEl;
    this.#metrics = metrics;
    this.#render = render;
    this.#onPainted = onPainted;
    this.#buffer = buffer;
    this.#scrollEl.addEventListener("scroll", this.#onScroll, { passive: true });
  }

  #scrollEl;
  #spacerEl;
  #windowEl;
  #metrics;
  #render;
  #onPainted;
  #buffer;

  /** @type {number} */
  #count = 0;

  /** @type {number|null} */
  #rafId = null;

  /**
   * Where the list is scrolled to, held here rather than read back from the element.
   *
   * A re-render replaces all three elements, so the offset has to be restored from state — the
   * same reason the library table keeps its own. Kept in sync by #onScroll.
   * @type {number}
   */
  #scrollTop = 0;

  /** @returns {number} */
  get scrollTop() {
    return this.#scrollTop;
  }

  /**
   * Point this instance at the elements of a freshly rendered part, keeping the offset.
   * @param {{scrollEl: HTMLElement, spacerEl: HTMLElement, windowEl: HTMLElement}} elements
   */
  rebind({ scrollEl, spacerEl, windowEl }) {
    this.#scrollEl.removeEventListener("scroll", this.#onScroll);
    this.#scrollEl = scrollEl;
    this.#spacerEl = spacerEl;
    this.#windowEl = windowEl;
    this.#scrollEl.addEventListener("scroll", this.#onScroll, { passive: true });
  }

  /**
   * How many items the list holds, and a repaint.
   * @param {number} count
   * @param {{resetScroll?: boolean}} [options] Reset after a change that makes the old offset point
   *   at something else — a different container selected, a filter applied.
   */
  setCount(count, { resetScroll = false } = {}) {
    this.#count = Math.max(0, count);
    if (resetScroll) this.#scrollTop = 0;
    this.paint({ restoreScroll: true });
  }

  /**
   * Repaint at the current offset. Cheap enough to call on any change: it writes one HTML string
   * and one transform.
   * @param {{restoreScroll?: boolean}} [options] Push the remembered offset back onto the element,
   *   which is only needed when the element itself is new.
   */
  paint({ restoreScroll = false } = {}) {
    const { rowHeight, columns = 1 } = this.#metrics();
    // A pad grid measured before its first layout has no width yet, and dividing by a zero pitch
    // would put every item in one row. Leaving the paint for the next call is right: the resize
    // observer that reports the real width fires one.
    if (!(rowHeight > 0) || !(columns > 0)) return;

    const rows = Math.ceil(this.#count / columns);
    this.#spacerEl.style.height = `${rows * rowHeight}px`;
    // After the spacer, so there is something to scroll through before the offset is applied.
    if (restoreScroll) this.#scrollEl.scrollTop = this.#scrollTop;

    const visibleRows = Math.ceil(this.#scrollEl.clientHeight / rowHeight);
    const startRow = Math.max(0, Math.floor(this.#scrollEl.scrollTop / rowHeight) - this.#buffer);
    const endRow = Math.min(rows, startRow + visibleRows + (this.#buffer * 2));
    const start = startRow * columns;
    const end = Math.min(this.#count, endRow * columns);

    // One innerHTML write of a joined string, never appendChild in a loop.
    this.#windowEl.innerHTML = end > start ? this.#render(start, end) : "";
    this.#windowEl.style.transform = `translateY(${startRow * rowHeight}px)`;
    this.#onPainted?.();
  }

  /** Stop listening. The elements themselves are the application's to discard. */
  destroy() {
    this.#scrollEl.removeEventListener("scroll", this.#onScroll);
    if (this.#rafId !== null) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
  }

  #onScroll = () => {
    this.#scrollTop = this.#scrollEl.scrollTop;
    if (this.#rafId !== null) return;
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = null;
      this.paint();
    });
  };
}
