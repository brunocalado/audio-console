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
import { AudioConsoleNormal } from "./apps/console-normal.js";

/**
 * Open whichever mode the GM last left the console in. Compact is imported dynamically: most
 * launches are normal mode, and there is no reason to pay for the second class's module graph on
 * every entry-point registration.
 * @returns {Promise<void>}
 */
async function openConsole() {
  // Checked here, not only on the two buttons: those decide whether a control is *drawn*, which
  // says nothing about `AudioConsole.Open()` typed into a macro by a player. The window would
  // render empty for them anyway, since the library is loaded on `ready` for the GM alone.
  if (!game.user?.isGM) {
    ui.notifications.warn("AUDIO_CONSOLE.Controls.GMOnly", { localize: true });
    return;
  }
  if (game.settings.get(MODULE_ID, SETTINGS.DISPLAY_MODE) === DISPLAY_MODES.COMPACT) {
    const { AudioConsoleCompact } = await import("./apps/console-compact.js");
    AudioConsoleCompact.open();
    return;
  }
  AudioConsoleNormal.open();
}

// Both entry points are GM-gated, and both gate inside the callback rather than at registration:
// during `init` there is no game.user yet. No keybinding, by design.
function registerEntryPoints() {
  // Scene control button, in the `sounds` group where audio modules belong. Payload shape
  // confirmed live in a v14 client: `controls` is keyed by group name and each group's `tools` is
  // keyed by tool name — both objects, not arrays. `order: 90` lands after core's tools (1–5) and
  // before the third-party module already sitting at 95.
  foundry.helpers.Hooks.on("getSceneControlButtons", controls => {
    if (!game.user?.isGM || !controls.sounds) return;
    controls.sounds.tools[MODULE_ID] = {
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
  foundry.helpers.Hooks.on("renderPlaylistDirectory", (app, element) => {
    if (!game.user?.isGM) return;
    const actions = element.querySelector(".directory-header .header-actions");
    if (!actions || actions.querySelector(`.${MODULE_ID}-open`)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${MODULE_ID}-open`;
    button.innerHTML = `<i class="fa-solid fa-sliders" inert></i><span inert>${foundry.utils.escapeHTML(game.i18n.localize("AUDIO_CONSOLE.Controls.Open"))}</span>`;
    button.addEventListener("click", () => openConsole());
    actions.append(button);
  });
}

foundry.helpers.Hooks.once("init", () => {
  registerSettings();
  registerSync();
  registerHotbarDrop();
  registerEntryPoints();
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
  }
});
