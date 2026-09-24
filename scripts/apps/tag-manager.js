/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { LIBRARY_CHANGED_HOOK, MAX_TAG_LENGTH, MIN_TAG_LENGTH, MODULE_ID } from "../constants.js";
import * as library from "../library/index.js";
import { confirmDeleteTag } from "./dialogs.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// Interpolated into the "not a usable tag name" warning, which is the only place a GM is told what
// the bounds actually are once the editor's own hint line was removed.
const TAG_BOUNDS = { min: MIN_TAG_LENGTH, max: MAX_TAG_LENGTH };

/**
 * The tag vocabulary, as a thing a GM curates rather than a side effect of tagging.
 *
 * A window of its own rather than a panel in the console: the console's Library section is where
 * tags are *applied*, and mixing "add a tag to this track" with "rename this tag on 200 tracks"
 * into one surface is how someone renames the vocabulary when they meant to retag one file. This
 * one is reached deliberately, from the tag filter panel's own Manage button.
 *
 * Every write here goes through library/index.js — the vocabulary and the rows it touches move
 * together in one save — and the console redraws off LIBRARY_CHANGED_HOOK like any other library
 * change, so nothing has to be told about anything.
 */
export class AudioConsoleTagManager extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-tags`,
    classes: [MODULE_ID, `${MODULE_ID}-tags`],
    tag: "div",
    window: {
      title: "AUDIO_CONSOLE.TagManager.Title",
      icon: "fa-solid fa-tags"
      // Not resizable: the list scrolls inside a fixed frame, so there is nothing a drag would
      // reveal that scrolling does not.
    },
    position: { width: 460, height: 560 },
    actions: {
      addTag: AudioConsoleTagManager.#onAddTag,
      renameTag: AudioConsoleTagManager.#onRenameTag,
      commitRename: AudioConsoleTagManager.#onCommitRename,
      cancelRename: AudioConsoleTagManager.#onCancelRename,
      deleteTag: AudioConsoleTagManager.#onDeleteTag
    }
  };

  /** @override */
  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/settings/tag-manager.hbs` }
  };

  /**
   * Render (or bring forward) the single instance.
   * @returns {AudioConsoleTagManager|Promise<AudioConsoleTagManager>}
   */
  static open() {
    const existing = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id);
    if (existing) {
      existing.bringToFront();
      return existing;
    }
    return new this().render({ force: true });
  }

  /** @type {number|null} */
  #libraryHookId = null;

  /** @type {string} Free-text filter over the vocabulary. Session-only. */
  #filter = "";

  /**
   * The tag whose name is currently being edited in place, or null. A field in the row rather than
   * a dialog: the list is where a GM notices the typo, and bouncing to a second window to fix one
   * word is most of the cost of fixing it.
   * @type {string|null}
   */
  #editing = null;

  /**
   * What is typed into that field. Held here rather than read only at commit time because a
   * library change elsewhere re-renders this window, which would otherwise discard a half-typed
   * name.
   * @type {string}
   */
  #editDraft = "";

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const needle = this.#filter.trim().toLowerCase();
    const all = [...library.getTagVocabulary().entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, info]) => ({ tag, count: info.count, group: info.group }));
    const rows = needle ? all.filter(row => row.tag.includes(needle)) : all;
    // Offered in the datalist beside every row, so grouping the second tag of a facet is a pick
    // rather than a second chance to spell it differently. Taken from the vocabulary itself — no
    // list of permitted groups exists anywhere, by design.
    context.groups = [...new Set(all.map(row => row.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    context.tags = rows.map(row => ({
      ...row,
      editing: row.tag === this.#editing,
      draft: row.tag === this.#editing ? this.#editDraft : row.tag
    }));
    context.filter = this.#filter;
    context.filtered = rows.length !== all.length;
    context.maxLength = MAX_TAG_LENGTH;
    return context;
  }

  /**
   * Redraw when the catalogue changes — including changes this window did not make, since the
   * edit dialog can coin a tag while this is open.
   * @inheritDoc
   */
  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelector("[data-tag-filter]")?.addEventListener("input", this.#onFilterInput);
    // Enter in the "new tag" field is the same action as its button; without this it does nothing,
    // which reads as the field being broken.
    this.element.querySelector("[data-new-tag]")?.addEventListener("keydown", this.#onNewTagKeydown);

    // `change`, not `input`: a group is committed when the field is left or Enter is pressed, so
    // typing "mood" does not write four one-letter groups on the way.
    for (const field of this.element.querySelectorAll("[data-group-input]")) {
      field.addEventListener("change", this.#onGroupChange);
    }

    const edit = this.element.querySelector("[data-rename-input]");
    if (edit) {
      edit.addEventListener("input", event => { this.#editDraft = event.target.value; });
      edit.addEventListener("keydown", this.#onRenameKeydown);
      // Selected, not merely focused: a rename usually replaces the name rather than appends to it.
      edit.focus();
      edit.select();
    }
    if (this.#libraryHookId !== null) return;
    this.#libraryHookId = foundry.helpers.Hooks.on(LIBRARY_CHANGED_HOOK, () => this.render());
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    if (this.#libraryHookId !== null) foundry.helpers.Hooks.off(LIBRARY_CHANGED_HOOK, this.#libraryHookId);
    this.#libraryHookId = null;
  }

  #onFilterInput = foundry.utils.debounce(event => {
    this.#filter = event.target.value;
    this.render();
  }, 120);

  /**
   * Move one tag into a facet — or out of every facet, when the field is emptied. The whole
   * consequence is in the console's filter panel: tags sharing a group become alternatives to each
   * other there instead of narrowing against each other.
   */
  #onGroupChange = event => {
    const { tag } = event.target.dataset;
    if (library.setTagGroups({ [tag]: event.target.value })) return;
    // Nothing changed — most often because the typed name normalises to what it already was. The
    // library fires no hook in that case, so the field is put back by hand rather than left
    // showing a name that was never stored.
    this.render();
  };

  #onNewTagKeydown = event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    this.#addTag();
  };

  #onRenameKeydown = event => {
    if (event.key === "Enter") {
      event.preventDefault();
      this.#commitRename();
      return;
    }
    if (event.key !== "Escape") return;
    // Stopped here so the key abandons the field rather than reaching ApplicationV2's own handler,
    // which would close the whole window.
    event.preventDefault();
    event.stopPropagation();
    this.#cancelRename();
  };

  /**
   * Rename across the whole library. Renaming onto a name that already exists merges the two, which
   * is the useful answer when "ambient" and "ambience" have grown up side by side — so the
   * notification says which of the two happened rather than leaving it to be discovered.
   */
  #commitRename() {
    const from = this.#editing;
    if (!from) return;
    const to = this.#editDraft;
    // Typing nothing, or the original name back, is a cancel — not an error worth a warning.
    if (!to.trim() || (to === from)) {
      this.#cancelRename();
      return;
    }
    const result = library.renameTag(from, to);
    if (!result) {
      // Stay in the field with the text intact: the fix is usually one character away.
      ui.notifications.warn(game.i18n.format("AUDIO_CONSOLE.TagManager.Notify.Invalid", TAG_BOUNDS));
      return;
    }
    this.#editing = null;
    this.#editDraft = "";
    ui.notifications.info(game.i18n.format(
      result.merged ? "AUDIO_CONSOLE.TagManager.Notify.Merged" : "AUDIO_CONSOLE.TagManager.Notify.Renamed",
      result));
    // renameTag() fired the library hook, so the list redraws on its own.
  }

  #cancelRename() {
    this.#editing = null;
    this.#editDraft = "";
    this.render();
  }

  /**
   * Coin a tag from the field at the top. It joins the vocabulary carrying nothing — which is the
   * point of being able to create one here rather than only by tagging something.
   */
  #addTag() {
    const input = this.element.querySelector("[data-new-tag]");
    const raw = input?.value ?? "";
    input.value = "";
    const result = library.createTag(raw);
    if (!result) {
      ui.notifications.warn(game.i18n.format("AUDIO_CONSOLE.TagManager.Notify.Invalid", TAG_BOUNDS));
      return;
    }
    if (!result.created) {
      ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.TagManager.Notify.Exists", { tag: result.tag }));
      return;
    }
    // createTag() already fired the library-changed hook, so the list redraws on its own.
    ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.TagManager.Notify.Created", { tag: result.tag }));
  }

  /** @this {AudioConsoleTagManager} */
  static async #onAddTag() {
    this.#addTag();
  }

  /**
   * Turn one row into an editable field. Only ever one at a time — a second pencil moves the edit
   * rather than opening another, so there is never a question of which field a keypress lands in.
   * @this {AudioConsoleTagManager}
   */
  static async #onRenameTag(event, target) {
    this.#editing = target.dataset.tag;
    this.#editDraft = target.dataset.tag;
    this.render();
  }

  /** @this {AudioConsoleTagManager} */
  static async #onCommitRename() {
    this.#commitRename();
  }

  /** @this {AudioConsoleTagManager} */
  static async #onCancelRename() {
    this.#cancelRename();
  }

  /**
   * Delete from the vocabulary and strip from every row that carries it. Confirmed by count,
   * because the rows losing it are not on screen here.
   * @this {AudioConsoleTagManager}
   */
  static async #onDeleteTag(event, target) {
    const tag = target.dataset.tag;
    const count = library.getTagVocabulary().get(tag)?.count ?? 0;
    if (!await confirmDeleteTag({ tag, count })) return;
    const result = library.deleteTag(tag);
    if (result) ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.TagManager.Notify.Deleted", result));
  }
}
