/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { DEFAULT_PAD_ICON, MODULE_ID } from "../constants.js";
import { basenameOf, humanizeName } from "../helpers.js";
import { getEntries } from "../data/repository.js";
import { readContainerFlags, readEntryFlags } from "../data/flag-models.js";
import { onContainerChange, onPlaybackChange } from "../data/sync.js";
import { boardsSharedWith, requestPad } from "../audio/shared-boards.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The player's window onto the soundboards the GM shared (audio/shared-boards.js): a pad grid
 * where a click fires or stops a pad, and nothing else — no configure, no reorder, no send, no
 * library.
 *
 * Its own class rather than the GM's popout with things switched off. That popout is the whole
 * console (console-normal.js) in a smaller frame, and hiding its GM controls one by one would
 * make every control added to it later a player control by default. Here a player can only do
 * what this file declares. It still wears the popout's classes, so the pads, the board colour
 * and the window read as the GM's popout does, from the same stylesheet.
 *
 * Tens of pads, not thousands — a board built for players is hand-picked — so the grid is plain
 * Handlebars and a redraw is a render, with no virtual window.
 */
export class AudioConsoleSharedBoard extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-shared`,
    classes: [MODULE_ID, `${MODULE_ID}-normal`, "ac-popout", "ac-shared-board"],
    tag: "div",
    window: {
      title: "AUDIO_CONSOLE.Shared.Title",
      icon: "fa-solid fa-grip",
      resizable: true
    },
    position: { width: 480, height: 420 },
    actions: {
      selectBoard: AudioConsoleSharedBoard.#onSelectBoard,
      firePad: AudioConsoleSharedBoard.#onFirePad
    }
  };

  /** @override */
  static PARTS = {
    board: { template: `modules/${MODULE_ID}/templates/normal/shared-board.hbs` }
  };

  /** Open the window, or bring the open one forward. */
  static open() {
    const existing = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id);
    if (existing) {
      existing.bringToFront();
      return;
    }
    new this().render({ force: true });
  }

  /** @type {string|null} The board on show; falls back to the first shared one. */
  #boardId = null;

  /** @type {Function[]} Unsubscribers for the two sync channels. */
  #unsubscribe = [];

  /** @returns {Playlist|null} */
  #board() {
    return game.playlists.get(this.#boardId) ?? null;
  }

  /** @override */
  async _prepareContext(options) {
    const boards = boardsSharedWith(game.user);
    if (!boards.some(board => board.id === this.#boardId)) this.#boardId = boards[0]?.id ?? null;
    const board = this.#board();
    const color = board ? readContainerFlags(board).color : null;
    return {
      // The switcher only earns its row when there is something to switch between.
      boards: (boards.length > 1)
        ? boards.map(b => ({ id: b.id, name: b.name, active: b.id === this.#boardId })) : [],
      board: board ? { color } : null,
      pads: getEntries(board).map(sound => {
        const flags = readEntryFlags(sound);
        return {
          id: sound.id,
          // The GM's grid prefers the library's name, but the library is loaded on the GM's client
          // alone (main.js); the pad's own label and document name are what a player has.
          name: flags.label || sound.name || humanizeName(basenameOf(sound.path)),
          playing: sound.playing,
          color: flags.color,
          icon: flags.icon || DEFAULT_PAD_ICON
        };
      })
    };
  }

  /**
   * Both channels redraw the whole window: at a player board's size a render is cheaper than
   * keeping painted tiles in step by hand, which is what the GM's thousand-pad grid has to do.
   * A board being shared or unshared arrives as a structural change like any other.
   * @override
   */
  _onFirstRender(context, options) {
    const redraw = () => this.render();
    this.#unsubscribe = [onContainerChange(redraw), onPlaybackChange(redraw)];
  }

  /** @override */
  _onClose(options) {
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe = [];
  }

  /** @this {AudioConsoleSharedBoard} */
  static #onSelectBoard(event, target) {
    this.#boardId = target.dataset.boardId;
    this.render();
  }

  /** @this {AudioConsoleSharedBoard} */
  static async #onFirePad(event, target) {
    const board = this.#board();
    const sound = board?.sounds.get(target.dataset.soundId);
    if (sound) await requestPad(board, sound);
  }
}
