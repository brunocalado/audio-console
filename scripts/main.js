/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID, DISPLAY_MODES, SETTINGS } from "./constants.js";
import { registerSettings } from "./settings.js";
import { bootstrap } from "./data/bootstrap.js";
import { registerSync } from "./data/sync.js";
import { registerHotbarDrop } from "./data/sound-macros.js";
import { loadLibrary } from "./library/index.js";
import { addLibraryEntries, importContainer, registerPack, runRegisteredPacks, syncPack } from "./api.js";
import { initRandomScheduler } from "./audio/random-scheduler.js";
import { initDucking } from "./audio/ducking.js";
import { initAutomation } from "./automation/engine.js";
import { boardsSharedWith, registerSharedBoards } from "./audio/shared-boards.js";
import { onContainerChange } from "./data/sync.js";
import { AudioConsoleNormal } from "./apps/console-normal.js";

/**
 * Whether this user has anything to open: the whole console for a GM, the shared-soundboard
 * window for a player the GM has shared at least one board with.
 * @returns {boolean}
 */
function canOpen() {
  return !!game.user && (game.user.isGM || (boardsSharedWith(game.user).length > 0));
}

/**
 * Open whichever mode the GM last left the console in; for a player, the shared soundboards. Compact is imported dynamically: most
 * launches are normal mode, and there is no reason to pay for the second class's module graph on
 * every entry-point registration.
 * @returns {Promise<void>}
 */
async function openConsole() {
  // Checked here, not only on the two buttons: those decide whether a control is *drawn*, which
  // says nothing about `AudioConsole.Open()` typed into a macro by a player. The window would
  // render empty for them anyway, since the library is loaded on `ready` for the GM alone. A player
  // gets their own window instead, imported on demand like compact mode.
  if (!game.user?.isGM) {
    if (!canOpen()) {
      ui.notifications.warn("AUDIO_CONSOLE.Controls.GMOnly", { localize: true });
      return;
    }
    const { AudioConsoleSharedBoard } = await import("./apps/shared-board.js");
    AudioConsoleSharedBoard.open();
    return;
  }
  if (game.settings.get(MODULE_ID, SETTINGS.DISPLAY_MODE) === DISPLAY_MODES.COMPACT) {
    const { AudioConsoleCompact } = await import("./apps/console-compact.js");
    AudioConsoleCompact.open();
    return;
  }
  AudioConsoleNormal.open();
}

// Both entry points are drawn for the GM, and for a player only while a board is shared with them;
// both gate inside the callback rather than at registration: during `init` there is no game.user
// yet. No keybinding, by design.
function registerEntryPoints() {
  // Scene control button, in the `sounds` group where audio modules belong. Payload shape
  // confirmed live in a v14 client: `controls` is keyed by group name and each group's `tools` is
  // keyed by tool name — both objects, not arrays. `order: 90` lands after core's tools (1–5) and
  // before the third-party module already sitting at 95.
  //
  // A player's button goes in `tokens` instead: core draws the `sounds` group for the GM alone
  // (SoundsLayer.prepareSceneControls, `visible: game.user.isGM`), and `tokens` is the group a
  // player always has. The order lands it after core's tools there too.
  foundry.helpers.Hooks.on("getSceneControlButtons", controls => {
    const group = game.user?.isGM ? controls.sounds : controls.tokens;
    if (!canOpen() || !group) return;
    group.tools[MODULE_ID] = {
      name: MODULE_ID,
      title: "AUDIO_CONSOLE.Controls.Open",
      icon: "fa-solid fa-sliders",
      button: true,
      visible: true,
      order: 90,
      onChange: () => openConsole()
    };
  });

  // Playlists sidebar header button, so the module is discoverable from where its documents live.
  // No data-action here: that attribute would be picked up by the sidebar's own click delegation.
  //
  // A row of its own above core's header, not a button inside it, and one element for the life of
  // the client. Core re-renders the whole directory on every Playlist update, replacing each part
  // element — and a playing ambience fires its random layers as updates about once a second. A
  // button inside the header part was rebuilt every time: it flickered under the pointer, and a
  // click whose press and release straddled a render never fired (Chrome drops it even when the same
  // node is put back). A sibling of the parts is never touched by a render.
  //
  // One row per directory, not per client: right-clicking the sidebar tab pops out a second
  // PlaylistDirectory instance (AbstractSidebarTab#renderPopout), and a single shared row was moved
  // into it and taken away from the sidebar. Anchored on the header part rather than on `element`,
  // which for the framed popout is the window itself, not the container the parts live in.
  const openRows = new WeakMap();
  foundry.helpers.Hooks.on("renderPlaylistDirectory", (app, element) => {
    let row = openRows.get(app);
    if (!canOpen()) {
      row?.remove();
      return;
    }
    const header = element.querySelector(".directory-header");
    if (!header || (row?.parentElement === header.parentElement)) return;
    if (!row) {
      row = document.createElement("div");
      row.className = `${MODULE_ID}-open-row action-buttons flexrow`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${MODULE_ID}-open`;
      button.innerHTML = `<i class="fa-solid fa-sliders" inert></i><span inert>${foundry.utils.escapeHTML(game.i18n.localize("AUDIO_CONSOLE.Controls.Open"))}</span>`;
      button.addEventListener("click", () => openConsole());
      row.append(button);
      openRows.set(app, row);
    }
    header.before(row);
  });
}

foundry.helpers.Hooks.once("init", () => {
  registerSettings();
  registerSync();
  registerHotbarDrop();
  registerEntryPoints();
  registerSharedBoards();
  // The macro-facing surface. A global rather than the module's `api` object because this exists
  // to be typed by hand into a one-line script macro, and openConsole already carries both the GM
  // check and the normal/compact preference. The rest is the setup API (api.js, docs/API.md);
  // `.api` on the module is the same object, for modules that follow Foundry's convention.
  globalThis.AudioConsole = {
    Open: openConsole,
    registerPack,
    import: importContainer,
    syncPack,
    library: { add: addLibraryEntries }
  };
  game.modules.get(MODULE_ID).api = globalThis.AudioConsole;
});

foundry.helpers.Hooks.once("ready", async () => {
  await bootstrap();
  // Every client, players included: ducking acts on each client's own music channel.
  initDucking();
  // GM-only interface — players never see the console, so there is nothing for them to load the
  // catalogue into memory for, and nothing for them to schedule.
  if (game.user.isGM) {
    await loadLibrary();
    initRandomScheduler();
    // After bootstrap, because a rule's first evaluation resolves the container it names, and
    // after loadLibrary for no reason other than keeping the GM-only block in one order.
    await initAutomation();
    // Last: a pack's containers are ordinary documents once built, and the automation rules that
    // may name them resolve on their first evaluation either way.
    await runRegisteredPacks();
  } else {
    // The player's two entry points appear and disappear with sharing. Neither redraws on a
    // playlist change by itself, so they are told when the answer to canOpen() flips — and only
    // then, since soundboards change far more often than their sharing does.
    let could = canOpen();
    onContainerChange(() => {
      if (canOpen() === could) return;
      could = !could;
      ui.controls.render({ reset: true });
      ui.playlists.render();
    });
  }
});
