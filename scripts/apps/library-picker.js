/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { CHANNELS, CHANNEL_ICONS, CHANNEL_LABEL_KEYS, MODULE_ID, PICKER_DRAG_TYPE } from "../constants.js";
import { dirnameOf, humanizeName, normalizePath } from "../helpers.js";
import { getEntries, isContainer } from "../data/repository.js";
import * as library from "../library/index.js";
import { TREE_INDENT, buildFolderTree, flattenFolderTree, renderTreeGutter } from "./folder-tree.js";
import { VirtualList } from "./virtual-list.js";

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
 * The rows are a scroll window (virtual-list.js), like the Library table's. Painting every row
 * was measured in v14.368 against the Tabletop Audio pack's 3081 rows: 26,600 elements, ~1.5 s to
 * open and ~500 ms for any repaint — a fold, Select All, a filter, a retarget after each drop —
 * while building the tree itself took 14 ms. Every row is one --ac-row-height tall, folders
 * included, which is the one thing the window's arithmetic needs.
 *
 * The window always has a target — the container it was opened on — and the target follows the
 * console rather than staying fixed: selecting a card there, or dropping rows from here onto a
 * card or an empty stretch of a container list, makes that container the target (the console
 * calls AudioConsoleLibraryPicker.retarget). So a GM filling several containers from one folder
 * keeps one window open, and the title always says where "Add Selected" is going.
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
   * Open the picker on `container`.
   *
   * One at a time, and an already-open one is closed rather than brought forward: two pickers
   * aimed at two different containers, both looking identical, is a way to add fifty tracks to the
   * wrong one.
   * @param {{container: Playlist, add: (container: Playlist, paths: string[]) => Promise<void>}} options
   *   `add` is the console's own insert, so an entry is shaped by the section it lands in.
   */
  static async open({ container, add }) {
    await foundry.applications.instances.get(this.DEFAULT_OPTIONS.id)?.close();
    await new this({ container, add }).render({ force: true });
  }

  /**
   * Point the open picker, if there is one, at another container — or at the same one again after
   * its contents changed, which is what a drop onto the current target is.
   * @param {Playlist} container
   */
  static retarget(container) {
    foundry.applications.instances.get(this.DEFAULT_OPTIONS.id)?.#retarget(container);
  }

  /**
   * `container` and `add` are destructured out before `super()` on purpose: ApplicationV2 runs
   * whatever it is handed through mergeObject against DEFAULT_OPTIONS, and deep-merging a Document
   * into the options object is work (and a copy) the framework has no use for.
   * @param {{container: Playlist, add: Function}} options Plus any ApplicationV2 option.
   */
  constructor({ container, add, ...options }) {
    super(options);
    this.#container = container;
    this.#add = add;
    // The catalogue as it stood when the window opened. Filling containers and editing the
    // library are separate jobs, so the window never re-reads it; reopening does.
    this.#pool = library.getAllEntries();
    this.#candidates = this.#candidatesFor(container);
  }

  /** @type {Playlist} Where "Add Selected" goes. */
  #container;

  /** @type {(container: Playlist, paths: string[]) => Promise<void>} */
  #add;

  /** @type {object[]} Every library row, as of opening. */
  #pool = [];

  /** @type {object[]} The pool minus what the target already holds — what this window offers. */
  #candidates = [];

  /** @type {number|null} */
  #deleteHookId = null;

  /** Paths ticked so far, kept across filter and fold changes (which rebuild every row). */
  #selected = new Set();

  /** @type {{text: string, tags: Set<string>, channels: Set<string>}} */
  #filters = { text: "", tags: new Set(), channels: new Set(Object.values(CHANNELS)) };

  #tagPanelOpen = false;

  /** Folder paths currently collapsed, by dirnameOf(entry.path). Session-only. */
  #collapsedFolders = new Set();

  /** @type {object[]} The flattened folder/entry rows the scroll window pages through. */
  #rows = [];

  /** @type {VirtualList|null} */
  #virtual = null;

  /**
   * Selected/total matched entries per folder path, from #tallyFolders. Kept so a scroll repaint
   * can set the painted folder boxes without re-counting every matched entry each frame.
   * @type {Map<string, {total: number, selected: number}>}
   */
  #folderTally = new Map();

  /** @type {object[]} Every entry the current filters match, collapsed folders included. */
  #matched = [];

  /** @type {HTMLElement|null} */ #tableEl = null;
  /** @type {HTMLElement|null} */ #rowsEl = null;
  /** @type {HTMLElement|null} */ #emptyEl = null;
  /** @type {HTMLElement|null} */ #statusEl = null;
  /** @type {HTMLButtonElement|null} */ #submitEl = null;
  /** @type {HTMLElement|null} */ #submitCountEl = null;

  /** @override */
  get title() {
    return game.i18n.format("AUDIO_CONSOLE.Picker.TitleFor", { name: this.#container.name });
  }

  /**
   * @param {Playlist} container
   * @returns {object[]}
   */
  #candidatesFor(container) {
    const inContainer = new Set(getEntries(container).map(sound => normalizePath(sound.path)));
    return this.#pool.filter(entry => !inContainer.has(entry.path));
  }

  /**
   * The ticks survive a change of target, minus whatever the new target already holds — which is
   * also how a drop clears the rows it just delivered.
   * @param {Playlist} container
   */
  #retarget(container) {
    if (!isContainer(container)) return;
    this.#container = container;
    this.#candidates = this.#candidatesFor(container);
    const offered = new Set(this.#candidates.map(entry => entry.path));
    for (const path of this.#selected) {
      if (!offered.has(path)) this.#selected.delete(path);
    }
    // The tag chips offered are the candidates' own vocabulary, so an open panel needs the full
    // render. Otherwise only the title and the rows change, and a full render would repaint the
    // whole window for them after every drop.
    if (this.#tagPanelOpen) return void this.render({ window: { title: this.title } });
    this.window.title.textContent = this.title;
    this.#applyFilter();
  }

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

    const elements = {
      scrollEl: this.element.querySelector("[data-picker-scroll]"),
      spacerEl: this.element.querySelector("[data-picker-spacer]"),
      windowEl: this.#rowsEl
    };
    if (this.#virtual) this.#virtual.rebind(elements);
    else {
      this.#virtual = new VirtualList({
        ...elements,
        // base.css owns the number. Read off the window root rather than a row or the list: a
        // re-render replaces those, and a detached node answers "" for a custom property.
        metrics: () => ({ rowHeight: parseFloat(getComputedStyle(this.element)
          .getPropertyValue("--ac-row-height")) || 0 }),
        render: (start, end) => this.#rows.slice(start, end)
          .map(row => (row.kind === "folder" ? this.#renderFolderRow(row) : this.#renderRow(row)))
          .join(""),
        // `indeterminate` has no attribute, so a folder box that just scrolled into view is set here.
        onPainted: () => this.#paintFolderChecks()
      });
    }

    // Ticking a box is a `change`, which DEFAULT_OPTIONS.actions cannot see — and delegating it to
    // the list means the handler survives every repaint instead of being rebound per row.
    this.#rowsEl.addEventListener("change", this.#onCheckChange);
    this.#rowsEl.addEventListener("dragstart", this.#onRowDragStart);
    this.element.querySelector("[data-picker-search]")?.addEventListener("input", this.#onSearchInput);

    this.#applyFilter();
  }

  /**
   * The scroll window only paints as many rows as the list is tall, and nothing else tells it the
   * list changed height: the first position (and size) is applied after _onRender, and a resize
   * drag after that.
   * @inheritDoc
   */
  _onPosition(position) {
    super._onPosition(position);
    this.#virtual?.paint();
  }

  /** @inheritDoc */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    // A target deleted out from under the window leaves "Add Selected" nowhere to go.
    this.#deleteHookId = foundry.helpers.Hooks.on("deletePlaylist", playlist => {
      if (playlist.id === this.#container.id) this.close();
    });
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    if (this.#deleteHookId !== null) foundry.helpers.Hooks.off("deletePlaylist", this.#deleteHookId);
    this.#deleteHookId = null;
    this.#virtual?.destroy();
    this.#virtual = null;
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
    this.#matched = this.#matchingEntries();
    this.#rows = flattenFolderTree(buildFolderTree(this.#matched), this.#collapsedFolders);
    this.#paintRows();
    this.#updateStatus();
  }

  /** Hand the new row set to the scroll window, which paints only what is on screen. */
  #paintRows() {
    this.#folderTally = this.#tallyFolders();
    this.#virtual.setCount(this.#rows.length);

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
    const dragLabel = e(game.i18n.localize("AUDIO_CONSOLE.Picker.DragHint"));
    return `<label class="ac-row ac-picker-row${boundary}" title="${path}" draggable="true" data-drag-path="${path}">
      ${renderTreeGutter(row.depth, true, row.last)}
      <input type="checkbox" class="ac-picker-check" data-path="${path}"${this.#selected.has(row.entry.path) ? " checked" : ""}>
      <span class="ac-picker-name">${e(row.entry.name)}</span>
      <i class="fa-solid fa-up-down-left-right ac-picker-grip" role="img" aria-label="${dragLabel}" data-tooltip="${dragLabel}"></i>
    </label>`;
  }

  /**
   * A folder header: a checkbox for everything under it, then the same icon/name/count line the
   * Library tab draws as one plain button that folds it.
   *
   * The row itself is a div holding the two as siblings rather than one button, because a
   * checkbox inside a button is interactive content nested in interactive content
   * (.claude/rules/ui-patterns.md: never). The fold stays a real button so a keyboard user can
   * get past a folder, and the checkbox is a real checkbox so it tabs and toggles like a track's.
   * Its checked/indeterminate state is set afterwards by #syncFolderChecks — `indeterminate` has
   * no HTML attribute to write here.
   *
   * The Library's bulk "collapse subfolders" control is still not here: one-click-per-folder is no
   * hardship in a window opened to pick a handful of tracks.
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
    const label = e(game.i18n.format("AUDIO_CONSOLE.Picker.SelectFolder", { name: row.name }));
    const dragLabel = e(game.i18n.localize("AUDIO_CONSOLE.Picker.DragHint"));
    return `<div class="ac-row ac-row-folder ac-picker-row${boundary}" draggable="true" data-drag-folder="${path}">
      ${renderTreeGutter(row.depth)}
      <input type="checkbox" class="ac-picker-check" data-folder-check="${path}" aria-label="${label}" data-tooltip="${label}">
      <button type="button" class="ac-picker-folder-toggle"
          data-action="toggleFolder" data-folder-path="${path}" aria-expanded="${collapsed ? "false" : "true"}">
        <i class="fa-solid ${collapsed ? "fa-folder" : "fa-folder-open"} ac-folder-icon${collapsed ? "" : " open"}" inert></i>
        <span class="ac-folder-name" title="${path}">${e(row.name)}</span>
        <span class="ac-folder-count">(${row.count})</span>
      </button>
      <i class="fa-solid fa-up-down-left-right ac-picker-grip" role="img" aria-label="${dragLabel}" data-tooltip="${dragLabel}"></i>
    </div>`;
  }

  /**
   * Is this entry anywhere under `folder`, nested subfolders included? Folder paths are the same
   * normalized dirname prefixes buildFolderTree walked, so a prefix match is the whole test.
   * @param {object} entry
   * @param {string} folder
   * @returns {boolean}
   */
  static #isUnder(entry, folder) {
    const dir = dirnameOf(entry.path);
    return (dir === folder) || dir.startsWith(`${folder}/`);
  }

  /** Re-count the folders against #selected and bring the painted folder boxes into line. */
  #syncFolderChecks() {
    this.#folderTally = this.#tallyFolders();
    this.#paintFolderChecks();
  }

  /**
   * How many matched entries each folder holds, and how many of those are selected. Counted in
   * one pass over the matched entries, crediting each to every ancestor prefix of its own
   * directory, rather than one pass per folder — a few hundred folders over a few thousand tracks
   * is otherwise real work on every tick.
   * @returns {Map<string, {total: number, selected: number}>}
   */
  #tallyFolders() {
    const tally = new Map();
    for (const entry of this.#matched) {
      const dir = dirnameOf(entry.path);
      const selected = this.#selected.has(entry.path);
      for (let i = dir.indexOf("/"); ; i = dir.indexOf("/", i + 1)) {
        const prefix = i === -1 ? dir : dir.slice(0, i);
        const counts = tally.get(prefix) ?? { total: 0, selected: 0 };
        counts.total++;
        if (selected) counts.selected++;
        tally.set(prefix, counts);
        if (i === -1) break;
      }
    }
    return tally;
  }

  /**
   * Set every painted folder checkbox from #folderTally: ticked when all of its matched entries
   * are selected, indeterminate when only some are.
   */
  #paintFolderChecks() {
    for (const input of this.#rowsEl.querySelectorAll("[data-folder-check]")) {
      const counts = this.#folderTally.get(input.dataset.folderCheck);
      input.checked = !!counts && (counts.selected === counts.total);
      input.indeterminate = !!counts && (counts.selected > 0) && (counts.selected < counts.total);
    }
  }

  /** Mirror #selected onto every painted checkbox, tracks and folders alike. */
  #syncChecks() {
    for (const input of this.#rowsEl.querySelectorAll("[data-path]")) {
      input.checked = this.#selected.has(input.dataset.path);
    }
    this.#syncFolderChecks();
  }

  /** The footer count and the submit button's own badge, which are the same number. */
  #updateStatus() {
    const count = this.#selected.size;
    if (this.#statusEl) {
      this.#statusEl.textContent = (this.#matched.length === this.#candidates.length)
        ? game.i18n.format("AUDIO_CONSOLE.Picker.Status.Total", { count, total: this.#candidates.length })
        : game.i18n.format("AUDIO_CONSOLE.Picker.Status.Filtered", { count, shown: this.#matched.length, total: this.#candidates.length });
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

  /**
   * A folder's box selects or clears everything the current filters match under it — collapsed
   * subfolders included, for the same reason Select All reaches into them. A partly selected
   * folder fills up rather than emptying: the browser has already flipped the box to checked, and
   * "tick the rest" is the likelier intent than throwing away the part already picked.
   */
  #onCheckChange = event => {
    const input = event.target;
    if (input.dataset.folderCheck !== undefined) {
      const folder = input.dataset.folderCheck;
      for (const entry of this.#matched) {
        if (!AudioConsoleLibraryPicker.#isUnder(entry, folder)) continue;
        if (input.checked) this.#selected.add(entry.path);
        else this.#selected.delete(entry.path);
      }
      this.#syncChecks();
    } else if (input.dataset.path !== undefined) {
      if (input.checked) this.#selected.add(input.dataset.path);
      else this.#selected.delete(input.dataset.path);
      this.#syncFolderChecks();
    } else return;
    this.#updateStatus();
  };

  /**
   * Rows leave for a container list in the console (console-normal.js #onContainerListDrop). A
   * ticked track carries the whole selection with it, hidden-by-filter ticks included, exactly as
   * "Add Selected" would; an unticked one carries itself. A folder carries what the filters show of
   * it, collapsed subfolders included, the same set its checkbox would tick.
   */
  #onRowDragStart = event => {
    const track = event.target.closest?.("[data-drag-path]");
    const folder = track ? null : event.target.closest?.("[data-drag-folder]");
    let paths;
    if (track) {
      const path = track.dataset.dragPath;
      paths = this.#selected.has(path) ? [...this.#selected] : [path];
    } else if (folder) {
      const dir = folder.dataset.dragFolder;
      paths = this.#matched.filter(entry => AudioConsoleLibraryPicker.#isUnder(entry, dir)).map(entry => entry.path);
    }
    if (!paths?.length) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(PICKER_DRAG_TYPE, JSON.stringify(paths));
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
    for (const entry of this.#matched) this.#selected.add(entry.path);
    this.#syncChecks();
    this.#updateStatus();
  }

  /** @this {AudioConsoleLibraryPicker} */
  static async #onClearSelection() {
    this.#selected.clear();
    this.#syncChecks();
    this.#updateStatus();
  }

  /** @this {AudioConsoleLibraryPicker} */
  static async #onSubmit() {
    if (!this.#selected.size) return;
    await this.#add(this.#container, [...this.#selected]);
    await this.close();
  }
}
