/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { CHANNELS, CHANNEL_ICONS, CHANNEL_LABEL_KEYS, MODULE_ID } from "../constants.js";
import { humanizeName } from "../helpers.js";
import * as library from "../library/index.js";
import { TREE_INDENT, buildFolderTree, flattenFolderTree, renderTreeGutter } from "./folder-tree.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SEARCH_DEBOUNCE_MS = 120;

/**
 * "Add from Library": pick tracks out of the catalogue to drop into a playlist, soundboard or
 * ambience mix.
 *
 * This was a DialogV2 living in dialogs.js. It is an Application now for one reason that a dialog
 * could not give it: a dialog owns its own chrome — a translucent core-themed frame and a footer
 * of parchment buttons — so the picker read as a piece of Foundry that had wandered into the
 * console rather than a part of it, and its confirm button sat below a list a GM has to scroll.
 * As an Application it carries this module's own window classes, lays the submit control out with
 * the rest of the header, and shares the Library tab's folder tree, chips and row visuals outright
 * (folder-tree.js, base.css) instead of approximating them.
 *
 * The list deliberately shows no tags per row: with a well-tagged catalogue the chips crowd the
 * name off its own line and give the window a horizontal scrollbar. Tags are a
 * way to *narrow* what is on offer here, not information to read per row — so they live in the
 * filter panel above, in the same chips the Library tab uses, and a row shows nothing but its
 * name, truncated.
 *
 * Unlike the Library table this paints every matched row rather than a virtual window: the row
 * body is a checkbox and a name, filtering and folding rebuild the whole list anyway, and a few
 * thousand of these is one innerHTML write of a joined string. The scroll container is still
 * bounded and internal, so the header controls never move off-screen.
 */
export class AudioConsoleLibraryPicker extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-picker`,
    classes: [MODULE_ID, `${MODULE_ID}-picker`],
    tag: "div",
    window: {
      title: "AUDIO_CONSOLE.Picker.Title",
      icon: "fa-solid fa-book",
      resizable: true
    },
    // Wide enough for the whole header to stay on one line: search, the channel facet, the tag
    // toggle, Clear filters, and the three selection controls. Narrower and .ac-section-header
    // wraps them onto a second row, which costs the list the height it was widened to save. The
    // channel facet added a control to that row after 820 was chosen, and Clear filters is always
    // rendered here (hidden, not absent), so the line has to fit its widest state, not its
    // resting one. Measured: at 900 that state overflows by 17px, because the search field is a
    // fixed 260 and no longer gives width back when the button appears (base.css
    // .ac-filter-controls). 940 leaves ~23px, and matches the console's own default width.
    position: { width: 940, height: 640 },
    actions: {
      toggleTagPanel: AudioConsoleLibraryPicker.#onToggleTagPanel,
      toggleChannel: AudioConsoleLibraryPicker.#onToggleChannel,
      toggleTag: AudioConsoleLibraryPicker.#onToggleTag,
      clearFilters: AudioConsoleLibraryPicker.#onClearFilters,
      toggleFolder: AudioConsoleLibraryPicker.#onToggleFolder,
      selectAll: AudioConsoleLibraryPicker.#onSelectAll,
      clearSelection: AudioConsoleLibraryPicker.#onClearSelection,
      submit: AudioConsoleLibraryPicker.#onSubmit
    }
  };

  /** @override */
  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/settings/library-picker.hbs` }
  };

  /**
   * Open the picker over `candidates` and resolve with what the GM chose.
   *
   * One at a time, and an already-open one is closed rather than brought forward: two pickers
   * feeding two different playlists, both looking identical, is a way to add fifty tracks to the
   * wrong one. Closing resolves the older call with `null`, so its caller simply adds nothing.
   * @param {{candidates: object[]}} options Library rows not already in the target container.
   * @returns {Promise<string[]|null>} Chosen paths, or null if nothing was chosen / dismissed.
   */
  static async open({ candidates }) {
    await foundry.applications.instances.get(this.DEFAULT_OPTIONS.id)?.close();
    const picker = new this({ candidates });
    const chosen = new Promise(resolve => { picker.#resolve = resolve; });
    await picker.render({ force: true });
    return chosen;
  }

  /**
   * `candidates` is destructured out before `super()` on purpose: ApplicationV2 runs whatever it
   * is handed through mergeObject against DEFAULT_OPTIONS, and deep-merging a few thousand
   * catalogue rows into the options object is real work for a value the framework has no use for.
   * @param {{candidates?: object[]}} [options] Plus any ApplicationV2 option.
   */
  constructor({ candidates = [], ...options } = {}) {
    super(options);
    this.#candidates = candidates;
  }

  /** @type {object[]} The fixed pool this window picks from — never re-read from the catalogue. */
  #candidates = [];

  /** @type {((paths: string[]|null) => void)|null} */
  #resolve = null;

  /** Paths ticked so far, kept across filter and fold changes (which rebuild every row). */
  #selected = new Set();

  /** @type {{text: string, tags: Set<string>, channels: Set<string>}} */
  #filters = { text: "", tags: new Set(), channels: new Set(Object.values(CHANNELS)) };

  #tagPanelOpen = false;

  /** Folder paths currently collapsed, by dirnameOf(entry.path). Session-only. */
  #collapsedFolders = new Set();

  /** @type {object[]} The flattened folder/entry rows currently painted. */
  #rows = [];

  #matchedCount = 0;

  /** @type {HTMLElement|null} */ #tableEl = null;
  /** @type {HTMLElement|null} */ #rowsEl = null;
  /** @type {HTMLElement|null} */ #emptyEl = null;
  /** @type {HTMLElement|null} */ #statusEl = null;
  /** @type {HTMLButtonElement|null} */ #submitEl = null;
  /** @type {HTMLElement|null} */ #submitCountEl = null;

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    // The vocabulary offered here is the one the candidates actually carry, not the library's
    // whole tag list: a chip that can only ever filter this window down to nothing is a dead
    // control, and the pool is already a subset (whatever is not in the target container yet).
    const tags = new Set();
    for (const entry of this.#candidates) {
      for (const tag of entry.tags) tags.add(tag);
    }

    context.filters = {
      text: this.#filters.text,
      tagCount: this.#filters.tags.size,
      hasAny: !!(this.#filters.text || this.#filters.tags.size
        || (this.#filters.channels.size !== Object.keys(CHANNELS).length))
    };
    context.tagPanelOpen = this.#tagPanelOpen;
    context.channels = Object.values(CHANNELS).map(channel => ({
      value: channel,
      label: CHANNEL_LABEL_KEYS[channel],
      icon: CHANNEL_ICONS[channel],
      active: this.#filters.channels.has(channel)
    }));
    // The same grouped blocks as the Library tab's panel, from the same model, so a facet joins
    // the same way in both. `vocabulary` is what keeps the pruning above: only tags a candidate
    // carries get a chip here.
    const pool = this.#candidates.filter(entry => this.#filters.channels.has(entry.channel)
      && this.#matchesText(entry));
    context.tagGroups = library.tagFacets(pool, this.#filters.tags, { vocabulary: tags })
      .map(block => ({
        group: block.group,
        label: block.group ? humanizeName(block.group)
          : game.i18n.localize("AUDIO_CONSOLE.Library.Tags.Ungrouped"),
        any: !!block.group,
        chips: block.tags
      }));
    return context;
  }

  /* -------------------------------------------- */
  /*  Render                                      */
  /* -------------------------------------------- */

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    this.#tableEl = this.element.querySelector("[data-picker-table]");
    if (!this.#tableEl) return;
    this.#rowsEl = this.element.querySelector("[data-picker-rows]");
    this.#emptyEl = this.element.querySelector("[data-picker-empty]");
    this.#statusEl = this.element.querySelector("[data-picker-status]");
    this.#submitEl = this.element.querySelector("[data-picker-submit]");
    this.#submitCountEl = this.element.querySelector("[data-picker-submit-count]");
    // Same single source of truth the Library table uses: the indent width is a JS constant
    // (folder-tree.js) pushed into CSS, never a number the stylesheet keeps its own copy of.
    this.#tableEl.style.setProperty("--ac-tree-col", `${TREE_INDENT}px`);

    // Ticking a box is a `change`, which DEFAULT_OPTIONS.actions cannot see — and delegating it to
    // the list means the handler survives every repaint instead of being rebound per row.
    this.#rowsEl.addEventListener("change", this.#onCheckChange);
    this.element.querySelector("[data-picker-search]")?.addEventListener("input", this.#onSearchInput);

    this.#applyFilter();
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    // Closing the window is an answer: "nothing". Whether it came from the header ✕ or from
    // #onSubmit having already resolved with a real selection, the caller is owed exactly one
    // settlement, so the handle is cleared as it is used.
    this.#resolve?.(null);
    this.#resolve = null;
  }

  /* -------------------------------------------- */
  /*  The row list                                */
  /* -------------------------------------------- */

  /**
   * Does this row match the text box? The name/path/tag rule library.search() applies, over one
   * entry, because this window filters its own candidate pool rather than the catalogue.
   * @param {object} entry
   * @returns {boolean}
   */
  #matchesText(entry) {
    const needle = this.#filters.text.trim().toLowerCase();
    if (!needle) return true;
    return entry.searchKey.includes(needle) || entry.tags.some(tag => tag.includes(needle));
  }

  /**
   * Everything in the candidate pool that survives the current text/tag/channel filters. The tag
   * rule is library.tagMatcher() itself, not a copy of it — grouped tags are alternatives to each
   * other and ungrouped ones narrow, exactly as in the Library tab — and the channel pair is an
   * OR-facet. It runs over this window's own pool rather than the catalogue, which is why it is
   * not library.search().
   * @returns {object[]}
   */
  #matchingEntries() {
    const matchesTags = library.tagMatcher(this.#filters.tags);
    return this.#candidates.filter(entry => this.#filters.channels.has(entry.channel)
      && matchesTags(entry) && this.#matchesText(entry));
  }

  /** Rebuild the row set from the candidate pool and repaint. */
  #applyFilter() {
    if (!this.#tableEl) return;
    const matched = this.#matchingEntries();
    this.#matchedCount = matched.length;
    this.#rows = flattenFolderTree(buildFolderTree(matched), this.#collapsedFolders);
    this.#paintRows();
    this.#updateStatus();
  }

  /** One innerHTML write of a joined string, never appendChild in a loop. */
  #paintRows() {
    this.#rowsEl.innerHTML = this.#rows
      .map(row => (row.kind === "folder" ? this.#renderFolderRow(row) : this.#renderRow(row)))
      .join("");

    // Two different empty states, and they need different words: an empty pool means everything in
    // the library is already in this container, while an empty result means the filters are too
    // narrow. Both replace the list rather than leaving a blank box.
    const empty = !this.#rows.length;
    this.#tableEl.classList.toggle("empty", empty);
    if (empty) {
      this.#emptyEl.textContent = game.i18n.localize(this.#candidates.length
        ? "AUDIO_CONSOLE.Picker.NoMatches"
        : "AUDIO_CONSOLE.Picker.Empty");
    }
  }

  /**
   * A track: the tree gutter, a checkbox, and the name. Nothing else — see this class's own header
   * on why the tags cell is gone. The whole row is the <label>, so a click anywhere along it ticks
   * the box rather than only the 15px square, and the checkbox takes its accessible name from the
   * track name it wraps — no aria-label to keep in step with the text beside it.
   * @param {{entry: object, depth: number, last: boolean}} row
   * @returns {string}
   */
  #renderRow(row) {
    const e = foundry.utils.escapeHTML;
    const path = e(row.entry.path);
    // `last` is the end of this folder's own run of tracks, and a node's entries are always
    // flattened after its subfolders — so the last entry is the last thing in that folder's whole
    // subtree, which is exactly where the one separator belongs.
    const boundary = row.last ? " ac-row-boundary" : "";
    return `<label class="ac-row ac-picker-row${boundary}" title="${path}">
      ${renderTreeGutter(row.depth, true, row.last)}
      <input type="checkbox" class="ac-picker-check" data-path="${path}"${this.#selected.has(row.entry.path) ? " checked" : ""}>
      <span class="ac-picker-name">${e(row.entry.name)}</span>
    </label>`;
  }

  /**
   * A folder header: the same icon/name/count line the Library tab draws, as one plain button.
   *
   * A button rather than the Library's `role="row"` div because this list has no grid to be a row
   * of, and a folder that only a mouse can fold is a folder a keyboard user cannot get past. That
   * choice is also why the Library's bulk "collapse subfolders" control is not here — it would
   * have to be a button inside a button (.claude/rules/ui-patterns.md: never), and one-click-per-folder is
   * no hardship in a window opened to pick a handful of tracks.
   * @param {{path: string, name: string, depth: number, count: number}} row
   * @returns {string}
   */
  #renderFolderRow(row) {
    const e = foundry.utils.escapeHTML;
    const collapsed = this.#collapsedFolders.has(row.path);
    const path = e(row.path);
    // Collapsed, this row *is* the whole folder, so it closes itself off; expanded, its contents
    // follow and the separator belongs after the last of them instead.
    const boundary = collapsed ? " ac-row-boundary" : "";
    return `<button type="button" class="ac-row ac-row-folder${boundary}"
        data-action="toggleFolder" data-folder-path="${path}" aria-expanded="${collapsed ? "false" : "true"}">
      ${renderTreeGutter(row.depth)}
      <i class="fa-solid ${collapsed ? "fa-folder" : "fa-folder-open"} ac-folder-icon${collapsed ? "" : " open"}" inert></i>
      <span class="ac-folder-name" title="${path}">${e(row.name)}</span>
      <span class="ac-folder-count">(${row.count})</span>
    </button>`;
  }

  /** The footer count and the submit button's own badge, which are the same number. */
  #updateStatus() {
    const count = this.#selected.size;
    if (this.#statusEl) {
      this.#statusEl.textContent = (this.#matchedCount === this.#candidates.length)
        ? game.i18n.format("AUDIO_CONSOLE.Picker.Status.Total", { count, total: this.#candidates.length })
        : game.i18n.format("AUDIO_CONSOLE.Picker.Status.Filtered", { count, shown: this.#matchedCount, total: this.#candidates.length });
    }
    if (this.#submitEl) this.#submitEl.disabled = count === 0;
    if (this.#submitCountEl) {
      this.#submitCountEl.textContent = String(count);
      this.#submitCountEl.hidden = count === 0;
    }
  }

  /* -------------------------------------------- */
  /*  Listeners                                   */
  /* -------------------------------------------- */

  #onSearchInput = foundry.utils.debounce(event => {
    this.#filters.text = event.target.value;
    this.#applyFilter();
    // Only the Clear filters button's presence depends on this, and re-rendering the window mid
    // keystroke would take the field's focus with it — so the header is patched in place.
    this.#syncClearFilters();
  }, SEARCH_DEBOUNCE_MS);

  #onCheckChange = event => {
    const input = event.target.closest("[data-path]");
    if (!input) return;
    if (input.checked) this.#selected.add(input.dataset.path);
    else this.#selected.delete(input.dataset.path);
    this.#updateStatus();
  };

  /**
   * The Clear filters button is always in the markup and hidden until a filter is on, because a
   * text-only filter change deliberately never re-renders (see #onSearchInput) — so there would
   * be no button to find if the template had left it out. Its visibility is reconciled here.
   */
  #syncClearFilters() {
    const button = this.element.querySelector('[data-action="clearFilters"]');
    const hasAny = !!(this.#filters.text || this.#filters.tags.size
      || (this.#filters.channels.size !== Object.keys(CHANNELS).length));
    if (button) button.hidden = !hasAny;
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /** @this {AudioConsoleLibraryPicker} */
  static async #onToggleTagPanel() {
    this.#tagPanelOpen = !this.#tagPanelOpen;
    await this.render();
  }

  /** @this {AudioConsoleLibraryPicker} */
  static async #onToggleChannel(event, target) {
    const channel = target.dataset.channel;
    if (!Object.values(CHANNELS).includes(channel)) return;
    if (this.#filters.channels.has(channel)) this.#filters.channels.delete(channel);
    else this.#filters.channels.add(channel);
    await this.render();
  }

  /** @this {AudioConsoleLibraryPicker} */
  static async #onToggleTag(event, target) {
    const tag = target.dataset.tag;
    if (this.#filters.tags.has(tag)) this.#filters.tags.delete(tag);
    else this.#filters.tags.add(tag);
    await this.render();
  }

  /** @this {AudioConsoleLibraryPicker} */
  static async #onClearFilters() {
    this.#filters = { text: "", tags: new Set(), channels: new Set(Object.values(CHANNELS)) };
    await this.render();
  }

  /** @this {AudioConsoleLibraryPicker} */
  static async #onToggleFolder(event, target) {
    const path = target.dataset.folderPath;
    if (this.#collapsedFolders.has(path)) this.#collapsedFolders.delete(path);
    else this.#collapsedFolders.add(path);
    this.#applyFilter();
  }

  /**
   * Everything the current filters match, whether or not its folder is expanded — folding is a way
   * to see less, not a way to select less, and a collapsed folder silently escaping "Select all"
   * is a selection a GM cannot see they are missing.
   * @this {AudioConsoleLibraryPicker}
   */
  static async #onSelectAll() {
    for (const entry of this.#matchingEntries()) this.#selected.add(entry.path);
    for (const input of this.#rowsEl.querySelectorAll("[data-path]")) input.checked = true;
    this.#updateStatus();
  }

  /** @this {AudioConsoleLibraryPicker} */
  static async #onClearSelection() {
    this.#selected.clear();
    for (const input of this.#rowsEl.querySelectorAll("[data-path]")) input.checked = false;
    this.#updateStatus();
  }

  /** @this {AudioConsoleLibraryPicker} */
  static async #onSubmit() {
    if (!this.#selected.size) return;
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.([...this.#selected]);
    await this.close();
  }
}
