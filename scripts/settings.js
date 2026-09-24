/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID, SETTINGS, CHANNELS, DISPLAY_MODES, AUDIO_MODES } from "./constants.js";
import { LibraryMaintenanceSettings } from "./apps/settings-library.js";
import { refresh as refreshAutomation } from "./automation/engine.js";

// No game.keybindings registration, by design.
export function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.DISPLAY_MODE, {
    name: "AUDIO_CONSOLE.Settings.DisplayMode.Name",
    hint: "AUDIO_CONSOLE.Settings.DisplayMode.Hint",
    scope: "client",
    config: false, // driven by the console's own expand/compact controls, not the settings sheet
    type: String,
    choices: {
      [DISPLAY_MODES.NORMAL]: "AUDIO_CONSOLE.Settings.DisplayMode.Normal",
      [DISPLAY_MODES.COMPACT]: "AUDIO_CONSOLE.Settings.DisplayMode.Compact"
    },
    default: DISPLAY_MODES.NORMAL
  });

  game.settings.register(MODULE_ID, SETTINGS.AUDIO_MODE, {
    name: "AUDIO_CONSOLE.Settings.AudioMode.Name",
    hint: "AUDIO_CONSOLE.Settings.AudioMode.Hint",
    scope: "client",
    config: false, // the preview/broadcast interlock — changed only via the transport bar toggle
    type: String,
    choices: {
      [AUDIO_MODES.PREVIEW]: "AUDIO_CONSOLE.Settings.AudioMode.Preview",
      [AUDIO_MODES.BROADCAST]: "AUDIO_CONSOLE.Settings.AudioMode.Broadcast"
    },
    default: AUDIO_MODES.PREVIEW
  });

  // Pure bookkeeping for console-compact.js's _initializeApplicationOptions — never rendered on
  // the settings sheet, so it carries no name/hint. {} means "no saved position yet", which
  // leaves the frameless bar to fall back to ApplicationV2's own centered default.
  game.settings.register(MODULE_ID, SETTINGS.COMPACT_POSITION, {
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });

  // The Library tab's last tag/channel filter selection, so reopening the console restores the
  // GM's own habitual filter set instead of resetting to a blank slate. Driven entirely by the
  // tag panel itself, never the settings sheet — every channel starts selected, which is the
  // "nothing filtered" baseline.
  game.settings.register(MODULE_ID, SETTINGS.LIBRARY_FILTERS, {
    scope: "client",
    config: false,
    type: Object,
    default: { tags: [], channels: Object.values(CHANNELS) }
  });

  // The container each of Playlists, Soundboard and Ambience last had open, keyed by section. A
  // section resolves this against the live container list on every render, so an id left here by a
  // container that has since been deleted costs nothing and is never cleaned up.
  game.settings.register(MODULE_ID, SETTINGS.SELECTED_CONTAINERS, {
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });

  // The section the console was last showing. Validated against the known tab ids on read, so a
  // value left here by a section that no longer exists falls back to the default rather than
  // rendering a window with no active tab.
  game.settings.register(MODULE_ID, SETTINGS.ACTIVE_SECTION, {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });

  // The automation rule list. World scope — every rule names a container and possibly a scene by
  // id, so it means nothing in another world, and a second GM must see the same list. Both
  // automation settings re-enter the engine through onChange rather than being polled: a world
  // setting's onChange runs on every client (v14.367, client/documents/setting.mjs:48-51), so the
  // GM who edits a rule and the GM actually driving the engine are told by the same write.
  game.settings.register(MODULE_ID, SETTINGS.AUTOMATION_RULES, {
    scope: "world",
    config: false, // edited in the console's Automation section, never on the settings sheet
    type: Array,
    default: [],
    onChange: () => refreshAutomation()
  });

  // Off on a fresh install, and off after every change of mind: automation reaches the table
  // without anyone's hand on the mixer, so it starts disarmed and stays that way until the GM
  // says otherwise.
  game.settings.register(MODULE_ID, SETTINGS.AUTOMATION_ARMED, {
    scope: "world",
    config: false, // driven by the Automation section's own arm switch
    type: Boolean,
    default: false,
    onChange: () => refreshAutomation()
  });

  // Recovery and moving-installation tools, moved off the console's own toolbar (rarely used, and
  // confusing to see sitting next to the daily-loop controls) and into Foundry's own Settings tab.
  game.settings.registerMenu(MODULE_ID, SETTINGS.LIBRARY_MAINTENANCE_MENU, {
    name: "AUDIO_CONSOLE.Settings.LibraryMaintenance.MenuName",
    hint: "AUDIO_CONSOLE.Settings.LibraryMaintenance.MenuHint",
    label: "AUDIO_CONSOLE.Settings.LibraryMaintenance.MenuLabel",
    icon: "fa-solid fa-screwdriver-wrench",
    type: LibraryMaintenanceSettings,
    restricted: true
  });
}
