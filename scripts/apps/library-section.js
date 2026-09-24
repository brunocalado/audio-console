/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { AUDIO_MODES, CHANNELS, CHANNEL_ICONS, CHANNEL_LABEL_KEYS, DEFAULT_CHANNEL, MODULE_ID, SETTINGS, SOUND_DRAG_MARKER } from "../constants.js";
import { basenameOf, humanizeName, normalizePath } from "../helpers.js";
import { createSoundMacro, soundForEntry } from "../data/sound-macros.js";
import * as library from "../library/index.js";
import * as playback from "../audio/playback.js";
import * as preview from "../audio/preview.js";
import { TREE_INDENT, buildFolderTree, flattenFolderTree, renderTreeGutter } from "./folder-tree.js";
import {
  confirmRemoveEntry,
  confirmRemoveFolder,
  promptEditEntry,
  promptNewEntry,
  promptScanOptions
} from "./dialogs.js";

// The Library tab: the virtualised catalogue table, its filters, the folder tree and every action
// a library row offers. Owned by the normal console (console-normal.js) as one object, the way the
// Automation section is a file of its own — the console is the window, this is the tab.
//
// The table body is not rendered by Handlebars. At a few thousand entries the catalogue is
// ~18,000 elements to parse and lay out on every render, so the template renders the chrome and
// #paintRows writes only the rows inside the scroll window, as one innerHTML string.

// Row geometry. Every offset here derives from ROW_HEIGHT, which bind() pushes into CSS as
// --ac-row-height so the stylesheet cannot drift from it.
const ROW_HEIGHT = 36;
const ROW_BUFFER = 8;
const SEARCH_DEBOUNCE_MS = 120;

// A row's height is fixed, so the tags cell renders at most MAX_ROW_TAGS chips whose lengths sum
// to at most MAX_ROW_TAG_CHARS, and folds the rest into one "+N" chip. The full set is always the
// cell's own tooltip. No cap is placed on how many tags a track carries.
const MAX_ROW_TAGS = 3;
const MAX_ROW_TAG_CHARS = 28;

export class LibrarySection {
  /** @param {import("./console-normal.js").AudioConsoleNormal} app The window this tab lives in. */
  constructor(app) {
    this.#app = app;
    this.#filters = this.#loadPersistedFilters();
  }

  /** @type {import("./console-normal.js").AudioConsoleNormal} */
  #app;

  /**
   * Filter state. `channels` is a facet (OR within, AND against the rest — library.search()), seeded
   * from the persisted setting. `text` is never persisted: a stale search silently narrowing the
   * table on reopen would be a surprise, not a convenience.
   * @type {{text: string, tags: Set<string>, channels: Set<string>}}
   */
  #filters;

  /** Whether the tag panel is open. Not persisted: it is filtering chrome, not a habit. */
  #tagPanelOpen = false;

  /** The flattened folder/entry rows the virtual window indexes into. */
  #rows = [];

  /** Folder paths currently collapsed. Session-only, like #filters. */
  #collapsedFolders = new Set();

  #focusedIndex = -1;
  #scrollTop = 0;
  #rafId = null;

  #gridEl = null;
  #scrollEl = null;
  #spacerEl = null;
  #rowsEl = null;
  #emptyEl = null;

  /* -------------------------------------------- */
  /*  Filter persistence                          */
  /* -------------------------------------------- */

  /** @returns {{text: string, tags: Set<string>, channels: Set<string>}} */
  #loadPersistedFilters() {
    const saved = game.settings.get(MODULE_ID, SETTINGS.LIBRARY_FILTERS) ?? {};
    const known = Object.values(CHANNELS);
    const channels = Array.isArray(saved.channels)
      ? saved.channels.filter(channel => known.includes(channel))
      : known;
    return {
      text: "",
      tags: new Set(Array.isArray(saved.tags) ? saved.tags : []),
      channels: new Set(channels)
    };
  }

  #persistFilters() {
    game.settings.set(MODULE_ID, SETTINGS.LIBRARY_FILTERS, {
      tags: [...this.#filters.tags],
      channels: [...this.#filters.channels]
    });
  }

  /**
   * The channel a newly registered file defaults to: the single channel the GM is filtered to, or
   * DEFAULT_CHANNEL when the filter says nothing.
   * @type {string}
   */
  get defaultChannel() {
    return (this.#filters.channels.size === 1) ? [...this.#filters.channels][0] : DEFAULT_CHANNEL;
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @param {object} context The render context; the library part's keys are added to it. */
  prepareContext(context) {
    context.filters = {
      text: this.#filters.text,
      tagCount: this.#filters.tags.size,
      // Every channel selected is the baseline: a facet with all its boxes ticked narrows nothing.
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
    // One block per tag group: within a block chips widen the result, between blocks they narrow
    // it (library.search). A chip that would empty the table is drawn dead rather than hidden.
    const pool = library.search({ text: this.#filters.text, channels: [...this.#filters.channels] });
    const blocks = library.tagFacets(pool, this.#filters.tags);
    context.tagGroups = blocks.map(block => ({
      group: block.group,
      // An ungrouped block goes unlabelled when it is the only block there is.
      label: block.group ? humanizeName(block.group)
        : (blocks.length > 1 ? game.i18n.localize("AUDIO_CONSOLE.Library.Tags.Ungrouped") : ""),
      any: !!block.group,
      chips: block.tags
    }));
  }

  /* -------------------------------------------- */
  /*  Render                                      */
  /* -------------------------------------------- */

  /**
   * Bind the table after a render. The Library is a section part like any other, so it may not be
   * in the DOM at all; everything here survives that.
   * @param {object} options The render options, for `parts`.
   */
  onRender(options) {
    const element = this.#app.element;
    this.#gridEl = element.querySelector("[data-library-grid]");
    if (!this.#gridEl) return;
    this.#scrollEl = element.querySelector("[data-library-scroll]");
    this.#spacerEl = element.querySelector("[data-library-spacer]");
    this.#rowsEl = element.querySelector("[data-library-rows]");
    this.#emptyEl = element.querySelector("[data-library-empty]");
    this.#gridEl.style.setProperty("--ac-row-height", `${ROW_HEIGHT}px`);
    this.#gridEl.style.setProperty("--ac-tree-col", `${TREE_INDENT}px`);

    // Non-click listeners; clicks go through the actions map. The handlers are stable arrow
    // fields, so re-adding one to an element that survived a partial render is a no-op.
    this.#scrollEl.addEventListener("scroll", this.#onScroll, { passive: true });
    this.#scrollEl.addEventListener("keydown", this.#onRowKeydown);
    this.#scrollEl.addEventListener("mousedown", this.#onRowMouseDown);
    this.#scrollEl.addEventListener("dragstart", this.#onEntryGripDragStart);
    element.querySelector("[data-library-search]")?.addEventListener("input", this.#onSearchInput);

    // Repaint only when the library part itself rendered: a partial render of another section
    // leaves this grid untouched, and repainting would drop the keyboard focus row for nothing.
    if (!options.parts || options.parts.includes("library")) this.#applyFilter({ resetScroll: false });
  }

  /** Closing destroys the content element; forget everything that pointed into it. */
  onClose() {
    if (this.#rafId !== null) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
    this.#gridEl = null;
    this.#scrollEl = null;
    this.#spacerEl = null;
    this.#rowsEl = null;
    this.#emptyEl = null;
  }

  /* -------------------------------------------- */
  /*  The virtualised table                       */
  /* -------------------------------------------- */

  /**
   * Rebuild the row set from the catalogue and repaint. Filtering resets the scroll offset: once
   * the set has changed, a preserved position points at a different track.
   * @param {{resetScroll?: boolean}} [options]
   */
  #applyFilter({ resetScroll = true } = {}) {
    if (!this.#gridEl) return;
    const matched = library.search({
      text: this.#filters.text,
      tags: [...this.#filters.tags],
      channels: [...this.#filters.channels]
    });
    this.#rows = flattenFolderTree(buildFolderTree(matched), this.#collapsedFolders);
    this.#focusedIndex = -1;
    if (resetScroll) this.#scrollTop = 0;

    // An empty catalogue gets its own message, distinct from "filtered to nothing".
    this.#gridEl.classList.toggle("empty", library.getAllEntries().length === 0);

    // aria-rowcount is the expanded tree plus the header row.
    this.#gridEl.setAttribute("aria-rowcount", String(this.#rows.length + 1));
    this.#spacerEl.style.height = `${this.#rows.length * ROW_HEIGHT}px`;
    this.#scrollEl.scrollTop = this.#scrollTop;
    this.#paintRows();
  }

  /** @param {string} path */
  #toggleFolder(path) {
    if (this.#collapsedFolders.has(path)) this.#collapsedFolders.delete(path);
    else this.#collapsedFolders.add(path);
    this.#applyFilter({ resetScroll: false });
  }

  /** Paint only the rows inside the scroll window, plus a buffer above and below. */
  #paintRows() {
    if (!this.#rowsEl) return;
    const scrollTop = this.#scrollEl.scrollTop;
    const visible = Math.ceil(this.#scrollEl.clientHeight / ROW_HEIGHT);
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_BUFFER);
    const end = Math.min(this.#rows.length, start + visible + (ROW_BUFFER * 2));

    // Localised once per paint, not once per row.
    const labels = {
      channelName: Object.fromEntries(Object.values(CHANNELS).map(channel => [
        channel, game.i18n.localize(CHANNEL_LABEL_KEYS[channel])
      ])),
      preview: game.i18n.localize("AUDIO_CONSOLE.Library.Actions.Preview"),
      play: game.i18n.localize("AUDIO_CONSOLE.Library.Actions.PlayToTable"),
      queue: game.i18n.localize("AUDIO_CONSOLE.Library.Actions.AddToQueue"),
      drag: game.i18n.localize("AUDIO_CONSOLE.Library.Actions.Drag"),
      macro: game.i18n.localize("AUDIO_CONSOLE.Library.Actions.Macro"),
      macroHint: game.i18n.localize("AUDIO_CONSOLE.Library.Actions.MacroHint"),
      edit: game.i18n.localize("AUDIO_CONSOLE.Library.Actions.Edit"),
      remove: game.i18n.localize("AUDIO_CONSOLE.Library.Actions.Remove"),
      removeFolder: game.i18n.localize("AUDIO_CONSOLE.Library.Actions.RemoveFolder"),
      collapseSubfolders: game.i18n.localize("AUDIO_CONSOLE.Library.Actions.CollapseSubfolders"),
      expandSubfolders: game.i18n.localize("AUDIO_CONSOLE.Library.Actions.ExpandSubfolders"),
      missingLabel: game.i18n.localize("AUDIO_CONSOLE.Library.Missing.Badge"),
      missingHint: game.i18n.localize("AUDIO_CONSOLE.Library.Missing.Hint")
    };
    const html = [];
    for (let index = start; index < end; index++) {
      const row = this.#rows[index];
      html.push(row.kind === "folder"
        ? this.#renderFolderRow(row, index, labels)
        : this.#renderRow(row.entry, index, labels, row));
    }
    this.#rowsEl.innerHTML = html.join("");
    this.#rowsEl.style.transform = `translateY(${start * ROW_HEIGHT}px)`;

    // Verify only what is on screen; a row already checked this session is skipped, and one that
    // comes back missing patches itself rather than repainting the grid.
    for (let index = start; index < end; index++) {
      const row = this.#rows[index];
      if ((row.kind === "entry") && !row.entry.missingChecked) this.#verifyRowMissing(row.entry);
    }

    // Focus is tracked by index, not by element: the element was just thrown away and rebuilt.
    if ((this.#focusedIndex >= start) && (this.#focusedIndex < end)) {
      this.#rowsEl.querySelector(`[data-index="${this.#focusedIndex}"]`)?.focus();
    }
  }

  /**
   * @param {object} entry
   * @param {number} index
   * @param {Record<string, string>} labels
   * @param {{depth: number, last: boolean}} treeRow
   * @returns {string}
   */
  #renderRow(entry, index, labels, treeRow) {
    const e = foundry.utils.escapeHTML;
    const shownTags = [];
    let charsUsed = 0;
    for (const tag of entry.tags) {
      if (shownTags.length >= MAX_ROW_TAGS) break;
      // Always take at least one tag: an empty cell reads as "no tags", which is worse than one
      // long chip. Every tag after the first still has to fit.
      if (shownTags.length && ((charsUsed + tag.length) > MAX_ROW_TAG_CHARS)) break;
      shownTags.push(tag);
      charsUsed += tag.length;
    }
    const hiddenTagCount = entry.tags.length - shownTags.length;
    const tags = shownTags.map(tag => `<span class="ac-row-tag">${e(tag)}</span>`).join("")
      + (hiddenTagCount > 0 ? `<span class="ac-row-tag ac-row-tag-more">+${hiddenTagCount}</span>` : "");
    // The channel is a cell of its own, icon only: an indicator, not a control. Changing the
    // channel is the Edit dialog's job.
    const channelName = labels.channelName[entry.channel];
    const tagsTitle = entry.tags.length ? ` title="${e(entry.tags.join(", "))}"` : "";
    const path = e(entry.path);
    const missingBadge = entry.missing
      ? `<span class="ac-missing-badge" data-tooltip="${e(labels.missingHint)}">${e(labels.missingLabel)}</span> ` : "";
    const gutter = renderTreeGutter(treeRow.depth, true, treeRow.last);
    // data-action on the row makes a plain click anywhere in it play the track; the buttons inside
    // are the nearer ancestor to their own click and win. The grip has no action: it is the only
    // draggable thing on the row, so a click-and-twitch cannot turn a play into a drag.
    const boundary = treeRow.last ? " ac-row-boundary" : "";
    return `<div class="ac-row${entry.missing ? " missing" : ""}${boundary}" role="row" tabindex="-1" aria-rowindex="${index + 2}" data-index="${index}" data-path="${path}" data-action="activateEntry">
      <span class="ac-cell ac-cell-name" role="gridcell" title="${path}">${gutter}<span class="ac-name-text">${missingBadge}${e(entry.name)}</span></span>
      <span class="ac-cell ac-cell-channel" role="gridcell" data-tooltip="${e(channelName)}">
        <i class="fa-solid ${CHANNEL_ICONS[entry.channel]} ac-channel-mark" inert></i>
        <span class="ac-visually-hidden">${e(channelName)}</span>
      </span>
      <span class="ac-cell ac-cell-tags" role="gridcell"${tagsTitle}>${tags}</span>
      <span class="ac-cell ac-cell-actions" role="gridcell">
        <button type="button" class="ac-row-action ac-row-grip" draggable="true" data-entry-grip aria-label="${e(labels.drag)}" data-tooltip="${e(labels.drag)}"><i class="fa-solid fa-up-down-left-right" inert></i></button>
        <button type="button" class="ac-row-action" data-action="previewEntry" aria-label="${e(labels.preview)}" data-tooltip="${e(labels.preview)}"><i class="fa-solid fa-headphones" inert></i></button>
        <button type="button" class="ac-row-action" data-action="playEntry" aria-label="${e(labels.play)}" data-tooltip="${e(labels.play)}"><i class="fa-solid fa-play" inert></i></button>
        <button type="button" class="ac-row-action" data-action="queueEntry" aria-label="${e(labels.queue)}" data-tooltip="${e(labels.queue)}"><i class="fa-solid fa-plus" inert></i></button>
        <button type="button" class="ac-row-action" data-action="createEntryMacro" aria-label="${e(labels.macro)}" data-tooltip="${e(labels.macroHint)}"><i class="fa-solid fa-scroll" inert></i></button>
        <button type="button" class="ac-row-action" data-action="editEntry" aria-label="${e(labels.edit)}" data-tooltip="${e(labels.edit)}"><i class="fa-solid fa-pen-to-square" inert></i></button>
        <button type="button" class="ac-row-action" data-action="removeEntry" aria-label="${e(labels.remove)}" data-tooltip="${e(labels.remove)}"><i class="fa-solid fa-trash" inert></i></button>
      </span>
    </div>`;
  }

  /**
   * A folder header row: same fixed height as an entry row, flexed edge-to-edge. The row itself
   * expands/collapses this folder; toggleSubfolders and removeFolder are nested actions that win
   * over it as the nearer ancestor to their own click.
   * @param {{path: string, name: string, depth: number, count: number, descendantFolders: string[],
   *   subfoldersCollapsed: boolean}} row
   * @param {number} index
   * @param {Record<string, string>} labels
   * @returns {string}
   */
  #renderFolderRow(row, index, labels) {
    const e = foundry.utils.escapeHTML;
    const collapsed = this.#collapsedFolders.has(row.path);
    const path = e(row.path);
    const subfoldersLabel = row.subfoldersCollapsed ? labels.expandSubfolders : labels.collapseSubfolders;
    const subfoldersButton = row.descendantFolders.length ? `
      <button type="button" class="ac-row-action" data-action="toggleSubfolders" data-folder-path="${path}"
              aria-label="${e(subfoldersLabel)}" aria-pressed="${row.subfoldersCollapsed ? "true" : "false"}"
              data-tooltip="${e(subfoldersLabel)}">
        <i class="fa-solid fa-folder-tree" inert></i>
      </button>` : "";
    const gutter = renderTreeGutter(row.depth);
    // Collapsed, this row is the whole folder and closes itself off; expanded, the separator
    // belongs after the last of its contents instead.
    const boundary = collapsed ? " ac-row-boundary" : "";
    return `<div class="ac-row ac-row-folder${boundary}" role="row" tabindex="-1" aria-rowindex="${index + 2}" data-index="${index}"
        data-action="toggleFolder" data-folder-path="${path}" aria-expanded="${collapsed ? "false" : "true"}">
      ${gutter}
      <i class="fa-solid ${collapsed ? "fa-folder" : "fa-folder-open"} ac-folder-icon${collapsed ? "" : " open"}" inert></i>
      <span class="ac-folder-name" title="${path}">${e(row.name)}</span>
      <span class="ac-folder-count">(${row.count})</span>
      <span class="ac-folder-actions">
        ${subfoldersButton}
        <button type="button" class="ac-row-action" data-action="removeFolder" data-folder-path="${path}"
                aria-label="${e(labels.removeFolder)}" data-tooltip="${e(labels.removeFolder)}">
          <i class="fa-solid fa-trash" inert></i>
        </button>
      </span>
    </div>`;
  }

  /**
   * Move the roving focus, scrolling the target row into the window first so it exists to be
   * focused once painted.
   * @param {number} index
   */
  #focusRow(index) {
    if ((index < 0) || (index >= this.#rows.length)) return;
    this.#focusedIndex = index;
    const top = index * ROW_HEIGHT;
    const viewTop = this.#scrollEl.scrollTop;
    const viewHeight = this.#scrollEl.clientHeight;
    if (top < viewTop) this.#scrollEl.scrollTop = top;
    else if ((top + ROW_HEIGHT) > (viewTop + viewHeight)) this.#scrollEl.scrollTop = top + ROW_HEIGHT - viewHeight;
    this.#scrollTop = this.#scrollEl.scrollTop;
    this.#paintRows();
  }

  /** @param {object} entry */
  async #verifyRowMissing(entry) {
    const missing = await library.checkMissing(entry);
    if (missing) this.#markRowMissing(entry);
  }

  /**
   * Patch one row's missing badge in place — never a re-render, which would cost a repaint of the
   * whole grid and reset the scroll offset.
   * @param {object} entry An entry already known to be missing.
   */
  #markRowMissing(entry) {
    if (!this.#rowsEl) return;
    const rowEl = [...this.#rowsEl.children].find(el => el.dataset.path === entry.path);
    if (!rowEl || rowEl.classList.contains("missing")) return;
    rowEl.classList.add("missing");
    const nameCell = rowEl.querySelector(".ac-cell-name");
    if (!nameCell) return;
    const badge = document.createElement("span");
    badge.className = "ac-missing-badge";
    badge.dataset.tooltip = game.i18n.localize("AUDIO_CONSOLE.Library.Missing.Hint");
    badge.textContent = game.i18n.localize("AUDIO_CONSOLE.Library.Missing.Badge");
    nameCell.prepend(badge, " ");
  }

  /* -------------------------------------------- */
  /*  DOM listeners                               */
  /* -------------------------------------------- */

  #onScroll = () => {
    this.#scrollTop = this.#scrollEl.scrollTop;
    if (this.#rafId !== null) return;
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = null;
      this.#paintRows();
    });
  };

  // Debounced on top of the precomputed lowercase search keys in library/index.js.
  #onSearchInput = foundry.utils.debounce(event => {
    this.#filters.text = event.target.value;
    this.#applyFilter();
  }, SEARCH_DEBOUNCE_MS);

  #onRowKeydown = event => {
    const last = this.#rows.length - 1;
    let next;
    switch (event.key) {
      case "ArrowDown": next = Math.min(last, this.#focusedIndex + 1); break;
      case "ArrowUp": next = Math.max(0, this.#focusedIndex - 1); break;
      case "Home": next = 0; break;
      case "End": next = last; break;
      case "Enter":
      case " ": {
        // A folder row is its own disclosure and an entry row its own play button, so Enter/Space
        // is what keyboard-only navigation needs to reach either.
        const row = this.#rows[this.#focusedIndex];
        if (!row) return;
        event.preventDefault();
        if (row.kind === "folder") this.#toggleFolder(row.path);
        else this.#activateEntry(row.entry);
        return;
      }
      default: return;
    }
    event.preventDefault();
    this.#focusRow(next);
  };

  #onRowMouseDown = event => {
    const row = event.target.closest?.("[data-index]");
    if (row) this.#focusedIndex = Number(row.dataset.index);
  };

  /**
   * A library row leaving the console: the canvas opens an AmbientSound preview at the cursor, the
   * hotbar leaves a standalone macro (data/sound-macros.js). A row has no document, so it carries
   * inline `data` where a pad carries a `uuid`; core's fromDropData reads either.
   */
  #onEntryGripDragStart = event => {
    const grip = event.target.closest("[data-entry-grip]");
    const entry = grip ? this.#entryFor(grip) : null;
    if (!entry) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("text/plain", JSON.stringify({
      type: "PlaylistSound",
      data: playback.soundSpecFor(entry),
      [MODULE_ID]: SOUND_DRAG_MARKER
    }));
    // The ghost is the row, not the 26px grip.
    const row = grip.closest(".ac-row");
    if (row) event.dataTransfer.setDragImage(row, 0, row.offsetHeight / 2);
  };

  /* -------------------------------------------- */
  /*  Registering files                            */
  /* -------------------------------------------- */

  /**
   * The library row a row-level action was fired from.
   * @param {HTMLElement} target
   * @returns {object|null}
   */
  #entryFor(target) {
    const path = target.closest("[data-path]")?.dataset.path;
    return path ? library.getEntry(path) : null;
  }

  /**
   * Pick one existing file and register it. Bringing a file in from outside Foundry is the
   * picker's own upload control; this module has no upload flow of its own.
   *
   * Shared with the container sections' Add button: this is the whole of "add a file", and where
   * the row goes next is the caller's business.
   * @returns {Promise<object|null>} The catalogue row, whether this call created it or found it
   *   already there. Null when a dialog was dismissed.
   */
  async pickAndRegister() {
    const path = await library.pickFile();
    if (!path) return null;
    const details = await promptNewEntry({
      path,
      name: humanizeName(basenameOf(path)),
      channel: this.defaultChannel
    });
    if (!details) return null;
    const added = library.addEntries([{ path, ...details }]);
    if (!added.length) {
      // Already catalogued: the row that is there keeps its own name and tags rather than being
      // overwritten by what was just typed — that is what its Edit button is for.
      ui.notifications.info(game.i18n.localize("AUDIO_CONSOLE.Library.Notify.AlreadyPresent"));
      return library.getEntry(path);
    }
    await library.flushSave();
    ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.Library.Notify.Added", { count: added.length }));
    return library.getEntry(path);
  }

  /* -------------------------------------------- */
  /*  Playback from a row                          */
  /* -------------------------------------------- */

  // Each of these declares where its audio is going and switches the mode to match, so the
  // transport's indicator can never describe a state the module is not in.

  /** @param {object} entry */
  async #previewEntry(entry) {
    await this.#app.setAudioMode(AUDIO_MODES.PREVIEW);
    const sound = await preview.preview(entry.path, { volume: entry.volume, channel: entry.channel });
    // AudioHelper.play() resolves a Sound even when the source 404s, so a failed load is silent
    // unless something reads .failed.
    if (sound?.failed) {
      entry.missing = true;
      entry.missingChecked = true;
      this.#markRowMissing(entry);
      ui.notifications.warn(game.i18n.format("AUDIO_CONSOLE.Transport.Notify.PlaybackFailed", { name: entry.name }));
    }
    this.#app.updateTransport();
  }

  /** @param {object} entry */
  async #playEntryToTable(entry) {
    await this.#app.setAudioMode(AUDIO_MODES.BROADCAST);
    await playback.playLibraryTrack(entry);
  }

  /**
   * A plain click on a row, or Enter/Space on a focused one. Which way it plays follows the
   * interlock rather than choosing for the GM — this deliberately never switches modes on its own.
   * @param {object|null} entry
   */
  async #activateEntry(entry) {
    if (!entry) return;
    if (this.#app.isBroadcasting) await this.#playEntryToTable(entry);
    else await this.#previewEntry(entry);
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  // Filter changes re-render the section chrome (chips, the clear button) rather than repainting
  // rows directly, so the scroll reset #applyFilter would do is asked for by hand.

  /**
   * The channel facet: an independent multi-select, not a radio — 0, 1 or 2 may be checked.
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  async onToggleChannel(event, target) {
    const channel = target.dataset.channel;
    if (this.#filters.channels.has(channel)) this.#filters.channels.delete(channel);
    else this.#filters.channels.add(channel);
    this.#persistFilters();
    this.#scrollTop = 0;
    await this.#app.render({ parts: ["library"] });
  }

  async onToggleTag(event, target) {
    const tag = target.dataset.tag;
    if (this.#filters.tags.has(tag)) this.#filters.tags.delete(tag);
    else this.#filters.tags.add(tag);
    this.#persistFilters();
    this.#scrollTop = 0;
    await this.#app.render({ parts: ["library"] });
  }

  async onToggleTagPanel() {
    this.#tagPanelOpen = !this.#tagPanelOpen;
    await this.#app.render({ parts: ["library"] });
  }

  /** Imported lazily: most sessions never curate the vocabulary. */
  async onManageTags() {
    const { AudioConsoleTagManager } = await import("./tag-manager.js");
    AudioConsoleTagManager.open();
  }

  async onClearFilters() {
    this.#filters = { text: "", tags: new Set(), channels: new Set(Object.values(CHANNELS)) };
    this.#persistFilters();
    this.#scrollTop = 0;
    await this.#app.render({ parts: ["library"] });
  }

  async onToggleFolder(event, target) {
    this.#toggleFolder(target.dataset.folderPath);
  }

  /**
   * Collapse every subfolder under one folder row, or expand them all back out. A partial state
   * reads as "collapsed", so one click from any mixed state lands on fully collapsed first.
   */
  async onToggleSubfolders(event, target) {
    const index = Number(target.closest("[data-index]")?.dataset.index);
    const row = this.#rows[index];
    if (!row?.descendantFolders?.length) return;
    if (row.subfoldersCollapsed) for (const path of row.descendantFolders) this.#collapsedFolders.delete(path);
    else for (const path of row.descendantFolders) this.#collapsedFolders.add(path);
    this.#applyFilter({ resetScroll: false });
  }

  async onAddFiles() {
    await this.pickAndRegister();
  }

  /** Browse a folder and register everything in it the catalogue does not already know. */
  async onScanFolder() {
    const dir = await library.pickFolder();
    if (!dir) return;
    const options = await promptScanOptions({ dir, channel: this.defaultChannel });
    if (!options) return;

    // FilePicker.browse() throws when the directory is gone rather than returning empty.
    let candidates;
    try {
      candidates = await library.scanFolder(dir, { recurse: options.recurse });
    } catch (err) {
      console.error(`${MODULE_ID} | could not scan ${dir}`, err);
      ui.notifications.error(game.i18n.format("AUDIO_CONSOLE.Library.Notify.ScanFailed", { dir }));
      return;
    }
    if (!candidates.length) {
      ui.notifications.info(game.i18n.localize("AUDIO_CONSOLE.Library.Notify.NothingNew"));
      return;
    }

    // One channel and one tag set for the whole folder — that is what a folder scan is for.
    const added = library.addEntries(candidates.map(candidate => ({
      ...candidate,
      channel: options.channel,
      tags: options.tags
    })));
    await library.flushSave();
    ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.Library.Notify.Added", { count: added.length }));
  }

  async onActivateEntry(event, target) {
    await this.#activateEntry(this.#entryFor(target));
  }

  async onPreviewEntry(event, target) {
    const entry = this.#entryFor(target);
    if (entry) await this.#previewEntry(entry);
  }

  async onPlayEntry(event, target) {
    const entry = this.#entryFor(target);
    if (entry) await this.#playEntryToTable(entry);
  }

  /** Append without playing. The queue is SEQUENTIAL, so whatever is playing advances into it. */
  async onQueueEntry(event, target) {
    const entry = this.#entryFor(target);
    if (!entry) return;
    const sound = await playback.appendToQueue(entry);
    if (sound) ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.Transport.Notify.Queued", { name: sound.name }));
  }

  /** Name, path, channel and tags for a row already in the catalogue — the add dialog, reopened. */
  async onEditEntry(event, target) {
    const entry = this.#entryFor(target);
    if (!entry) return;
    const details = await promptEditEntry({
      path: entry.path,
      name: entry.name,
      channel: entry.channel,
      tags: entry.tags
    });
    if (!details) return;

    // The path first: it is the catalogue's key, so the move has to succeed before there is a row
    // at the new path for the other writes to land on. A refusal aborts the whole edit.
    const wanted = normalizePath(details.path);
    const moved = library.moveEntry(entry.path, wanted);
    if (moved === "taken") {
      ui.notifications.warn(game.i18n.format("AUDIO_CONSOLE.Library.Notify.PathTaken", { path: wanted }));
      return;
    }
    if ((moved === "invalid") || (moved === "missing")) {
      ui.notifications.warn(game.i18n.localize("AUDIO_CONSOLE.Library.Notify.PathInvalid"));
      return;
    }
    const path = (moved === "moved") ? wanted : entry.path;

    // updateEntry() leaves tags alone; setTags() is what folds a typed tag into the vocabulary.
    // Both go through the same debounced save. A blank name keeps the current one.
    const name = details.name || entry.name;
    library.updateEntry(path, { name, channel: details.channel });
    library.setTags(path, details.tags);
    await library.flushSave();
    if (moved === "moved") {
      ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.Library.Notify.Repointed", { name, path }));
    }
  }

  async onRemoveEntry(event, target) {
    const entry = this.#entryFor(target);
    if (!entry) return;
    if (!await confirmRemoveEntry(entry)) return;
    library.removeEntries([entry.path]);
    await library.flushSave();
  }

  /**
   * Remove every catalogue row under a folder, subfolders included — the folder's whole real
   * contents, not just what the active filter is narrowing the tree to.
   */
  async onRemoveFolder(event, target) {
    const path = target.dataset.folderPath;
    if (!path) return;
    const prefix = `${path}/`;
    const matches = library.getAllEntries().filter(e => (e.path === path) || e.path.startsWith(prefix));
    if (!matches.length) return;
    // The same name the tree shows: a pack's folder is titled by its module, not by its id.
    const name = library.getFolderName(path) ?? (/^modules\/[^/]+$/.test(path)
      ? (game.modules.get(path.slice("modules/".length))?.title ?? path.split("/").pop())
      : path.split("/").pop());
    if (!await confirmRemoveFolder({ name, count: matches.length })) return;
    library.removeEntries(matches.map(e => e.path));
    await library.flushSave();
  }

  /** The same macro the grip's drag to the hotbar produces, minus the hotbar slot. */
  async onCreateEntryMacro(event, target) {
    const entry = this.#entryFor(target);
    if (entry) await createSoundMacro(soundForEntry(entry));
  }
}

/**
 * The click handlers this section contributes to the console's `actions` map. ApplicationV2 binds
 * `this` to the application, which owns the section as `librarySection`.
 */
export const LIBRARY_ACTIONS = Object.fromEntries([
  ["addFiles", "onAddFiles"],
  ["scanFolder", "onScanFolder"],
  ["toggleChannel", "onToggleChannel"],
  ["toggleTag", "onToggleTag"],
  ["toggleTagPanel", "onToggleTagPanel"],
  ["manageTags", "onManageTags"],
  ["clearFilters", "onClearFilters"],
  ["toggleFolder", "onToggleFolder"],
  ["toggleSubfolders", "onToggleSubfolders"],
  ["removeFolder", "onRemoveFolder"],
  ["editEntry", "onEditEntry"],
  ["removeEntry", "onRemoveEntry"],
  ["activateEntry", "onActivateEntry"],
  ["previewEntry", "onPreviewEntry"],
  ["playEntry", "onPlayEntry"],
  ["queueEntry", "onQueueEntry"],
  ["createEntryMacro", "onCreateEntryMacro"]
].map(([action, method]) => [action, function(event, target) { return this.librarySection[method](event, target); }]));
