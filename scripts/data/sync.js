/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { FLAGS, MODULE_ID } from "../constants.js";
import { containerKindOf, isContainer, isEntry, isSectionFolder } from "./repository.js";

// There is no second copy of a container anywhere in this module, so sync has nothing to
// reconcile. Its whole job is: a module-flagged document changed, tell whoever is rendering.
// No cleanup routine belongs here — a deleted document is simply absent from the next read.

const containerSubscribers = new Set();
const playbackSubscribers = new Set();

/**
 * Subscribe to *structural* container changes — a container created, deleted, renamed, an entry
 * added or removed, a folder touched. This is what re-renders the console.
 *
 * The callback is handed which *kinds* of container changed in this window, so a subscriber can
 * redraw one section instead of the window: a full render costs 145 ms with a 300-track playlist
 * selected against 11 ms for a single part, measured in v14.367.
 * @param {(kinds: Set<string>|null) => void} callback Called at most once per debounce window.
 *   `kinds` holds CONTAINER_KINDS values; `null` means "could not be attributed — redraw the lot".
 * @returns {() => void} Unsubscribe.
 */
export function onContainerChange(callback) {
  containerSubscribers.add(callback);
  return () => containerSubscribers.delete(callback);
}

/**
 * Subscribe to *playback* changes — something started, stopped, paused, or changed volume.
 * Deliberately a separate channel: these fire constantly during normal use, and the transport bar
 * answers them by writing its own elements rather than by re-rendering. Re-rendering the library
 * grid because a track advanced is the single most likely performance mistake in this module.
 * @param {() => void} callback
 * @returns {() => void} Unsubscribe.
 */
export function onPlaybackChange(callback) {
  playbackSubscribers.add(callback);
  return () => playbackSubscribers.delete(callback);
}

/**
 * @param {Set<Function>} subscribers
 * @param {string} label
 * @param {*} [payload] Handed to each callback.
 */
function fire(subscribers, label, payload) {
  for (const callback of subscribers) {
    try {
      callback(payload);
    } catch (err) {
      console.error(`${MODULE_ID} | a ${label} subscriber threw`, err);
    }
  }
}

// What changed since the last time subscribers were told, accumulated across the debounce window
// rather than reported per hook: playAll() on a twenty-layer ambience is twenty hooks and one
// notification, and the notification has to describe all twenty.
const pendingKinds = new Set();

// Set by a change no single section owns — a section folder moved, or a container whose kind flag
// itself is unreadable. Those redraw everything, which is the safe answer and a rare one.
let pendingAll = false;

// Debouncing is not optional. playAll() on a twenty-layer ambience fires twenty
// updatePlaylistSound hooks in one tick, and a volume drag fires continuously.
const notifyContainers = foundry.utils.debounce(() => {
  const kinds = pendingAll ? null : new Set(pendingKinds);
  pendingKinds.clear();
  pendingAll = false;
  fire(containerSubscribers, "container-change", kinds);
}, 100);

// Shorter, because the transport update it drives is a handful of DOM writes rather than a render,
// and a play press that takes 100 ms to show up reads as a dropped click.
const notifyPlayback = foundry.utils.debounce(() => fire(playbackSubscribers, "playback-change"), 50);

// The fields that describe *what is currently sounding* rather than what exists. An update whose
// changes are drawn entirely from this set never reaches the render path.
//   playing/pausedTime — transport state on both Playlist and PlaylistSound
//   volume             — a slider drag, already coalesced by PlaylistSound#debounceVolume
//   seed               — Playlist#seed, rerolled by shuffle so every client walks the same order
const PLAYBACK_FIELDS = new Set(["playing", "pausedTime", "volume", "seed"]);

/**
 * An empty change set counts as playback, not structure — `[].every()` is true and that is the
 * behaviour we want. A volume drag is exactly this case and it is not a curiosity: the slider
 * applies the value locally with `updateSource()` before asking `debounceVolume` to persist it
 * (core's own idiom, so the drag is audible without waiting for a round trip), so by the time the
 * write echoes back there is nothing left to diff and the hook is handed `{_id}` alone. Measured
 * in v14.365. Treating that as structural re-renders the library grid on every drag, which is
 * precisely the storm this split exists to prevent.
 *
 * @param {object} changed The diff handed to an update hook.
 * @returns {boolean} Whether this update is playback state and nothing else.
 */
function isPlaybackOnly(changed) {
  const keys = Object.keys(changed ?? {}).filter(key => (key !== "_id") && !key.startsWith("_"));
  return keys.every(key => {
    if (key === "sounds") return soundsArePlaybackOnly(changed.sounds);
    if (key === "flags") return flagsArePlaybackOnly(changed.flags);
    return PLAYBACK_FIELDS.has(key);
  });
}

/**
 * An ambience's `active` flag is written with every start and stop (audio/playback.js), so it is
 * playback state like `playing` beside it. Counted as structural it would re-render the section on
 * every Play — and rebuild every random timer, wiping the spread first fires the scheduler has
 * just armed for the ambience coming on.
 * @param {*} flags The `flags` entry of an update diff.
 * @returns {boolean}
 */
function flagsArePlaybackOnly(flags) {
  const scopes = Object.keys(flags ?? {});
  if ((scopes.length !== 1) || (scopes[0] !== MODULE_ID)) return false;
  return Object.keys(flags[MODULE_ID] ?? {}).every(key => key === FLAGS.ACTIVE);
}

/**
 * A Playlist update carries its sounds' changes as an embedded `sounds` array — and that is how
 * every start and stop arrives: playSound, playNext, playAll and this module's own stopContainer
 * all write `{playing, pausedTime}` per sound through the parent. Read literally, the `sounds` key
 * made every play and every stop structural, so the section re-rendered on the most frequent
 * thing a session does. An array whose every item is playback state is playback state; the
 * console keeps the rows it already drew in step through updateTransport() (console-normal.js
 * paint* methods). An item that adds, removes or renames a sound is structural, as before.
 * @param {*} sounds The `sounds` entry of an update diff.
 * @returns {boolean}
 */
function soundsArePlaybackOnly(sounds) {
  if (!Array.isArray(sounds)) return false;
  return sounds.every(item => isPlaybackOnly(item));
}

// Creates and deletes are always structural — a document appearing or vanishing changes the list,
// whatever else it says. Only updates get classified.
//
// The third column answers "which section draws this?", so a notification can name the part that
// has to be redrawn. A folder has no kind — it holds containers of one section rather than being
// one — so it returns null and the window redraws whole.
const WATCHED = [
  ["createPlaylist", isContainer, containerKindOf, false],
  ["updatePlaylist", isContainer, containerKindOf, true],
  ["deletePlaylist", isContainer, containerKindOf, false],
  ["createPlaylistSound", isEntry, sound => containerKindOf(sound.parent), false],
  ["updatePlaylistSound", isEntry, sound => containerKindOf(sound.parent), true],
  ["deletePlaylistSound", isEntry, sound => containerKindOf(sound.parent), false],
  ["createFolder", isSectionFolder, () => null, false],
  ["updateFolder", isSectionFolder, () => null, false],
  ["deleteFolder", isSectionFolder, () => null, false]
];

let registered = false;

/**
 * Register the nine document hooks. Each one filters first: the world is full of playlists that
 * are none of our business, and re-rendering for them is pure waste. On a delete the flag is
 * still populated on the document handed to the hook — that is the last chance to read it.
 */
export function registerSync() {
  if (registered) return;
  registered = true;
  for (const [hook, belongsToUs, kindOf, classify] of WATCHED) {
    foundry.helpers.Hooks.on(hook, (document, changed) => {
      if (!belongsToUs(document)) return;
      if (classify && isPlaybackOnly(changed)) notifyPlayback();
      else {
        const kind = kindOf(document);
        if (kind) pendingKinds.add(kind);
        else pendingAll = true;
        // A structural change can move playback too — a deleted entry was maybe the one playing —
        // so the transport is always told as well. It is cheap; the render is not.
        notifyContainers();
        notifyPlayback();
      }
    });
  }
}
