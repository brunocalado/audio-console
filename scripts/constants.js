/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

// Single source of truth for the id. Never a string literal anywhere else — see CLAUDE.md.
export const MODULE_ID = "audio-console";

// The module's folder in Foundry's data root, outside `modules/`. Deliberately equal to MODULE_ID
// so there is one name to remember. A constant rather than a setting: renaming it would strand
// every existing library.
export const LIBRARY_DIR = MODULE_ID;

// game.settings keys. Both scope: "client".
export const SETTINGS = {
  DISPLAY_MODE: "displayMode",
  AUDIO_MODE: "audioMode",
  // Internal bookkeeping only, never shown on the settings sheet: the compact bar's last screen
  // position, so re-opening it restores where the GM left it instead of re-centering.
  COMPACT_POSITION: "compactPosition",
  // registerMenu key for the Library maintenance settings app — recovery and moving-installation
  // tools, moved off the console's own toolbar so they never sit next to the daily-loop controls.
  LIBRARY_MAINTENANCE_MENU: "libraryMaintenanceMenu",
  // Internal bookkeeping only, never shown on the settings sheet: the Library tab's last tag/type
  // filter selection, so reopening the console keeps the GM's own habitual filter set instead of
  // resetting to a blank slate every time.
  LIBRARY_FILTERS: "libraryFilters",
  // Internal bookkeeping only, never shown on the settings sheet: which container each of the
  // three container sections had open last, so opening one lands on the board the GM was working
  // on rather than on an empty pane with a list beside it.
  SELECTED_CONTAINERS: "selectedContainers",
  // Internal bookkeeping only, never shown on the settings sheet: which section the console was
  // left on, so reopening it lands where the GM was rather than always on the Library.
  ACTIVE_SECTION: "activeSection",
  // The automation rule list. World scope, unlike everything above it: a rule points at a
  // container and a scene by id, so it is meaningless in another world and must not follow the
  // GM's browser the way the display preferences do.
  AUTOMATION_RULES: "automationRules",
  // Whether the automation engine is evaluating at all. World scope for the same reason the rules
  // are, plus one of its own: a second GM must not be able to think automation is off while it is
  // running on the active GM's client.
  AUTOMATION_ARMED: "automationArmed"
};

export const DISPLAY_MODES = {
  NORMAL: "normal",
  COMPACT: "compact"
};

// The safety interlock, enforced by console-base.js's setAudioMode(). Default is PREVIEW — a fresh
// install must not be able to surprise the table.
export const AUDIO_MODES = {
  PREVIEW: "preview",
  BROADCAST: "broadcast"
};

// Flag keys inside the MODULE_ID scope. The flag — never the folder — is what makes a document
// part of Audio Console, so these names are load-bearing — data/repository.js is the one module
// that reads them to decide membership.
export const FLAGS = {
  KIND: "kind",               // Playlist: which kind of container this is
  COLOR: "color",             // Playlist: optional accent colour
  SECTION: "section",         // Folder: which section folder this is
  RANDOM: "random",           // PlaylistSound: random-interval scheduler config
  ICON: "icon",               // PlaylistSound: the image a soundboard pad shows
  FAVORITE: "favorite",       // Playlist: pinned to the rail's Favorites list
  MACRO_FOLDER: "macroFolder", // Folder: the module's folder in the Macro sidebar
  SOUND_PATH: "soundPath",    // Macro: the audio file it plays — the pad-to-hotbar dedupe key
  PACK: "pack",               // Playlist: which content module built it, via the public API
  DUCK: "duck",               // Playlist (soundboard): lower the music channel while a pad sounds
  ACTIVE: "active"            // Playlist (ambience): switched on, whether or not a layer sounds right now
};

// How far ducking pulls the music channel down while a pad from a ducking soundboard plays, as a
// factor of the client's own music volume, and how long the ramp each way takes. Local to every
// client (audio/ducking.js) — no document is written and the GM's levels are never touched.
export const DUCK_FACTOR = 0.25;
export const DUCK_RAMP_S = 0.4;

// What a soundboard pad shows when the GM has not picked an image for it. A pad is aimed at, not
// read, so the face is an image and the track's name lives in its tooltip — which only works if
// there is always an image to draw. Core ships this one with every install, so it needs no asset
// of ours and cannot 404 on a fresh world.
//
// Stored on no pad: flag-models.js falls back to this rather than writing it out per pad, so a
// change here moves every pad that never had an icon picked for it.
export const DEFAULT_PAD_ICON = "icons/tools/instruments/megaphone.webp";

// What marks a drag as ours — a soundboard pad or a library row. Both declare
// `type: "PlaylistSound"`, because that is what a pad is (and what a row becomes, as an inline
// `data` payload) and because core's canvas drop switch matches that literal to open an
// AmbientSound preview at the cursor. So the type cannot say who started the drag, and this value
// does it instead, under `MODULE_ID` as key: core parses the payload with a plain JSON.parse and
// reads only `type`, `uuid` and `data`, leaving any other key untouched for us. Three call sites
// in two files — the two grips' dragstart, and the hotbarDrop handler that answers them — so a
// shared home is what keeps a typo in one of them from silently failing to match the others.
export const SOUND_DRAG_MARKER = "sound";

// flags["audio-console"].kind on a container Playlist.
export const CONTAINER_KINDS = {
  PLAYLIST: "playlist",
  SOUNDBOARD: "soundboard",
  AMBIENCE: "ambience",
  QUEUE: "queue"
};

// flags["audio-console"].section on the root Folder and its three children.
export const SECTIONS = {
  ROOT: "root",
  PLAYLISTS: "playlists",
  SOUNDBOARDS: "soundboards",
  AMBIENCES: "ambiences"
};

// Which of Foundry's audio channels an entry plays on — a field of its own on every library row,
// not a tag: routing (which of the user's volume sliders governs this sound) is a setting, and
// classifying ("this is a footstep") is a tag. Keeping them apart is what lets tags be optional,
// repeatable and free-text, while routing stays a single explicit value the GM sets at import and
// can change later.
//
// The values ARE Foundry's own channel ids (CONST.AUDIO_CHANNELS), so nothing has to map them on
// the way to a Sound. "interface" is deliberately not offered: it is core's channel for UI
// feedback, which this module never emits.
export const CHANNELS = {
  MUSIC: "music",
  ENVIRONMENT: "environment"
};

// What an entry gets when the GM does not choose — the value the import dialogs start on.
export const DEFAULT_CHANNEL = CHANNELS.MUSIC;

// The Font Awesome glyph standing in for each channel where a word will not fit — the Library
// table's own column, and the ambience mixer's row. Never on its own: every one of those carries
// a tooltip and an accessible label naming the channel, per .claude/rules/ui-patterns.md.
export const CHANNEL_ICONS = {
  [CHANNELS.MUSIC]: "fa-music",
  [CHANNELS.ENVIRONMENT]: "fa-wind"
};

// The localisation key naming each channel. Four surfaces show it — the Library rows and their
// filter chips, the picker's filter, the import dialogs and the ambience mixer — so the mapping
// lives here rather than being written out per app.
//
// These are *core's* keys, not ours — the exact values `CONST.AUDIO_CHANNELS` maps these two ids
// to, confirmed in a live v14.367 client. The channel is Foundry's own concept and the GM already
// sees it named in the Playlists sidebar under User Volume Controls ("Music", "Environment"); a
// module that invents a second word for the same slider is asking the GM to learn a synonym for
// nothing. Borrowing the keys also means the words track the
// client's language for free, and can never drift from the sliders they route to.
//
// Written out rather than derived from CONST.AUDIO_CHANNELS so this file stays a leaf that reads
// no globals at import time — and because that map carries "interface" too, which CHANNELS
// deliberately does not offer.
export const CHANNEL_LABEL_KEYS = {
  [CHANNELS.MUSIC]: "AUDIO.CHANNELS.MUSIC.label",
  [CHANNELS.ENVIRONMENT]: "AUDIO.CHANNELS.ENVIRONMENT.label"
};

// The subfolder under LIBRARY_DIR/audio/ each channel consolidates into. Separate from the channel
// id because "environment" names a mixer bus, and a folder called "ambient" is what a GM browsing
// their own data directory expects to find.
export const CONSOLIDATE_DIR_BY_CHANNEL = {
  [CHANNELS.MUSIC]: "music",
  [CHANNELS.ENVIRONMENT]: "ambient"
};

// The floor on a tag's length. Two characters is not a label, it is a typo that survived — the
// vocabulary is shared by the whole library now, so a stray "df" is offered on every track forever
// until someone hunts it down in the tag manager. Enforced on the way IN only (helpers.js
// sanitizeUserTags, library/index.js createTag/renameTag), never on catalogue load: an imported or
// hand-edited library.json that holds short tags keeps them rather than have them silently
// deleted. The tag manager is where those get cleaned up, deliberately and one at a time.
export const MIN_TAG_LENGTH = 3;

// A tag's slug is capped here — long enough for a descriptive tag ("tavern-crowd-noise" is 19
// characters), short enough that one pill can never dominate the Library table's TAGS column or
// the tag panel's chip grid. Enforced in helpers.js normalizeTag(), the one function every tag
// passes through on its way into the catalogue (dialog input, catalogue load, import merge).
export const MAX_TAG_LENGTH = 24;

// Fired (Hooks.callAll) whenever library/index.js's in-memory catalogue changes — add, retag,
// remove, reload. Debounced the same way as sync.js's container-change notification. Declared
// here, not inlined, because both the emitter (library/index.js) and the console's re-render
// subscription need the exact same string.
export const LIBRARY_CHANGED_HOOK = `${MODULE_ID}.libraryChanged`;

// Folder/document names created by bootstrap (data/bootstrap.js).
export const FOLDER_NAMES = {
  ROOT: "Audio Console",
  // The module's folder in the *Macro* sidebar, where a pad dragged onto the hotbar leaves its
  // macro. Deliberately the same name as ROOT: a different collection entirely, so there is no
  // clash, and a GM looking for the module's things should find the same word in both places.
  MACROS: "Audio Console",
  PLAYLISTS: "Playlists",
  SOUNDBOARDS: "Soundboards",
  AMBIENCES: "Ambiences",
  QUEUE: "Now Playing"
};

// The Macro folder's tint in the sidebar. The console's own accent (--ac-accent, #d4af37 in
// styles/base.css) taken down in value: at full brightness a folder colour reads as a highlight
// competing with the folder names, where the point is only to say "these are Audio Console's".
export const MACRO_FOLDER_COLOR = "#8a6d1f";

/* -------------------------------------------- */
/*  Automation                                  */
/* -------------------------------------------- */

// What an automation rule watches. The split that matters is not which hook each one hangs off,
// it is whether the trigger describes a STATE the world is in or an EVENT that happened, because
// only a state has an exit — see AUTOMATION_STATE_TRIGGERS below.
export const TRIGGER_TYPES = {
  WEATHER: "weather",
  DARKNESS: "darkness",
  SCENE: "scene",
  TIME: "time",
  COMBAT_START: "combatStart",
  COMBAT_END: "combatEnd"
};

// The triggers that describe a condition rather than a moment. A state rule fires when the world
// enters the condition and releases what it started when the world leaves it; an event rule fires
// and is done. Nothing else in the module branches on trigger type — everything asks this set.
export const AUTOMATION_STATE_TRIGGERS = new Set([
  TRIGGER_TYPES.WEATHER, TRIGGER_TYPES.DARKNESS, TRIGGER_TYPES.SCENE, TRIGGER_TYPES.TIME
]);

// How a darkness rule compares the scene's level against its threshold. Two rules with opposite
// operators over the same threshold are what makes a day/night pair: one leaves the condition at
// the exact moment the other enters it, so the handover needs no third concept.
export const DARKNESS_OPERATORS = {
  AT_LEAST: "atLeast",
  BELOW: "below"
};

// What a rule does when it fires.
//
// One action per container kind, deliberately, rather than a handful of general ones that each
// accept several kinds. It is the same information either way — but this way the Target list under
// an action holds only things that action can actually use, so it is filtered by construction and
// there is no combined list to scan past. Picking "play one pad" is picking the soundboards.
//
// Every one of these is a thin call into audio/playback.js, which is a native document write —
// automation broadcasts through exactly the same path a button press does, and adds no second way
// for audio to reach the table.
export const ACTION_TYPES = {
  PLAY_PLAYLIST: "playPlaylist",
  PLAY_AMBIENCE: "playAmbience",
  PLAY_TRACK: "playTrack",
  PLAY_PAD: "playPad",
  STOP_PLAYLIST: "stopPlaylist",
  STOP_SOUNDBOARD: "stopSoundboard",
  STOP_AMBIENCE: "stopAmbience",
  STOP_ALL: "stopAll"
};

// What each action needs and does, in one table — the only place any of it is written down.
//
//   kind   the container kind it may name, or null when it names nothing at all
//   entry  whether it acts on one sound inside that container rather than the whole thing
//   stop   whether it silences rather than starts
//
// Four things read this and would otherwise each carry their own switch: the Target list's filter,
// whether the track picker is on screen, how a rule describes itself in the list, and the engine's
// own dispatch.
//
// Two of the pairings are not policy, they are what the containers ARE. A soundboard is a grid of
// unrelated one-shots, so there is no "play the soundboard" — only a pad. An ambience is layers
// mixed to sound together, so there is no "play one layer" — only the whole bed. A playlist is the
// one container where both readings are real, which is why it is the only kind appearing twice.
export const ACTIONS = {
  [ACTION_TYPES.PLAY_PLAYLIST]: { kind: CONTAINER_KINDS.PLAYLIST, entry: false, stop: false },
  [ACTION_TYPES.PLAY_AMBIENCE]: { kind: CONTAINER_KINDS.AMBIENCE, entry: false, stop: false },
  [ACTION_TYPES.PLAY_TRACK]: { kind: CONTAINER_KINDS.PLAYLIST, entry: true, stop: false },
  [ACTION_TYPES.PLAY_PAD]: { kind: CONTAINER_KINDS.SOUNDBOARD, entry: true, stop: false },
  [ACTION_TYPES.STOP_PLAYLIST]: { kind: CONTAINER_KINDS.PLAYLIST, entry: false, stop: true },
  [ACTION_TYPES.STOP_SOUNDBOARD]: { kind: CONTAINER_KINDS.SOUNDBOARD, entry: false, stop: true },
  [ACTION_TYPES.STOP_AMBIENCE]: { kind: CONTAINER_KINDS.AMBIENCE, entry: false, stop: true },
  // Names no container: it stops every module container there is.
  [ACTION_TYPES.STOP_ALL]: { kind: null, entry: false, stop: true }
};

// How many fires the automation section's log keeps. Deliberately in memory and deliberately
// small: it exists to answer "did that rule just fire, and with what?" during a session, which is
// the question a GM actually has. Persisting it would be a world write per fire for a record
// nobody reads the next day.
export const AUTOMATION_LOG_SIZE = 20;

// Fired (Hooks.callAll) whenever the automation engine's own observable state changes — a rule
// fired, the log grew, the armed switch moved, the rule list was edited. Same role as
// LIBRARY_CHANGED_HOOK: the engine holds state the console draws but does not own, and this is how
// the console learns to redraw it without the engine knowing a window exists.
export const AUTOMATION_CHANGED_HOOK = `${MODULE_ID}.automationChanged`;
