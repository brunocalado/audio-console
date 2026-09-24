/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID, FLAGS, CONTAINER_KINDS, SECTIONS } from "../constants.js";
import { normalizePath } from "../helpers.js";
import { readContainerFlags, readSectionFlags } from "./flag-models.js";

// Read-only, pure functions over the live collections. Nothing here caches, and nothing here
// writes — creation lives in mutations.js and is orchestrated by bootstrap.js.
//
// This is the ONLY module that filters documents by flag. Anything that needs to know whether a
// document belongs to Audio Console asks here, so there is exactly one answer to that question.

/**
 * Membership is the flag, never the folder. A GM who drags a playlist out of the module folder
 * in the native sidebar keeps it in Audio Console, by design.
 * @param {Playlist} playlist
 * @returns {boolean}
 */
export function isContainer(playlist) {
  return !!playlist?.getFlag(MODULE_ID, FLAGS.KIND);
}

/**
 * Which section a container belongs to. Exists so a change to one section can redraw that section
 * alone (console-base.js) instead of the whole window — the flag read stays here, where every
 * other flag read in the module already lives.
 *
 * Safe on the document handed to a *delete* hook: the flags are still populated at that moment,
 * which is the last chance anything has to read them.
 * @param {Playlist} playlist
 * @returns {string|null} One of CONTAINER_KINDS, or null when this is not one of ours.
 */
export function containerKindOf(playlist) {
  return isContainer(playlist) ? (readContainerFlags(playlist).kind ?? null) : null;
}

/**
 * @param {Folder} folder
 * @returns {boolean}
 */
export function isSectionFolder(folder) {
  return folder?.type === "Playlist" && !!folder?.getFlag(MODULE_ID, FLAGS.SECTION);
}

/**
 * @param {PlaylistSound} sound
 * @returns {boolean}
 */
export function isEntry(sound) {
  return isContainer(sound?.parent);
}

/**
 * @param {string} section One of SECTIONS.
 * @returns {Folder|null} Null when it has not been created yet, or the GM deleted it.
 */
export function getSectionFolder(section) {
  return game.folders.find(f => isSectionFolder(f) && readSectionFlags(f).section === section) ?? null;
}

/**
 * The section folders, keyed by section. Purely a read: bootstrap.js is what creates the missing
 * ones, and it is the only thing that may.
 * @returns {Record<string, Folder|null>}
 */
export function getSections() {
  return Object.fromEntries(Object.values(SECTIONS).map(s => [s, getSectionFolder(s)]));
}

/**
 * @param {string} kind One of CONTAINER_KINDS.
 * @returns {Playlist[]} Sorted by name, so the list order does not depend on creation order.
 */
export function getContainers(kind) {
  return game.playlists
    .filter(p => isContainer(p) && readContainerFlags(p).kind === kind)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every container pinned to the rail's Favorites list, whatever its kind.
 *
 * Grouped by kind and then alphabetical inside each group, so the list reads the way the rail
 * above it does — playlists, then soundboards, then ambiences — rather than interleaving three
 * kinds by name. The queue is never a favorite: there is exactly one of it and it already has a
 * permanent place in the rail.
 * @returns {Playlist[]}
 */
export function getFavorites() {
  const order = [CONTAINER_KINDS.PLAYLIST, CONTAINER_KINDS.SOUNDBOARD, CONTAINER_KINDS.AMBIENCE];
  return game.playlists
    .filter(p => {
      if (!isContainer(p)) return false;
      const flags = readContainerFlags(p);
      return flags.favorite && order.includes(flags.kind);
    })
    .sort((a, b) => {
      const byKind = order.indexOf(readContainerFlags(a).kind) - order.indexOf(readContainerFlags(b).kind);
      return byKind || a.name.localeCompare(b.name);
    });
}

/**
 * The Now Playing scratch queue — the backing document for broadcasting a library track, which
 * is a path and not a document of its own.
 * @returns {Playlist|null}
 */
export function getQueue() {
  return game.playlists.find(p => isContainer(p) && readContainerFlags(p).kind === CONTAINER_KINDS.QUEUE) ?? null;
}

/**
 * The entries of a container, in playback order. This returns the native PlaylistSound documents
 * only — tags and the canonical name are a library concern, not a container-read concern, so a
 * caller resolves them per entry via library/index.js's getEntry(sound.path). An entry whose path
 * has no library row simply resolves to nothing there; it still appears in this list.
 * @param {Playlist} container
 * @returns {PlaylistSound[]}
 */
export function getEntries(container) {
  if (!container) return [];
  return [...container.sounds].sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
}

/**
 * @returns {Playlist|null} Whichever module container is currently playing.
 */
export function getNowPlaying() {
  return game.playlists.find(p => isContainer(p) && p.playing) ?? null;
}

/**
 * Whether a sound is parked mid-track rather than stopped or never played.
 *
 * The one test for this in the module. `pausedTime` is a number once a sound has genuinely been
 * paused (audio/playback.js pauseEntry writes the live offset); a sound that was created and never
 * played leaves the field *unset*, and PlaylistSound#pausedTime is `nullable, required: false`
 * with no initial, so it reads back as `undefined` rather than `null` (confirmed live, v14.365).
 * `!== null` therefore counts every fresh entry as paused. Number.isFinite() treats null and
 * undefined alike, so only a real stored offset passes.
 * @param {PlaylistSound} sound
 * @returns {boolean}
 */
export function isPaused(sound) {
  return !sound?.playing && Number.isFinite(sound?.pausedTime);
}

/**
 * Whether a container is switched on: sounding, or an ambience whose `active` flag says so while
 * none of its layers happens to be (see ContainerFlags.active).
 * @param {Playlist} container
 * @returns {boolean}
 */
export function isOn(container) {
  return !!container?.playing || readContainerFlags(container).active;
}

/**
 * The entry the transport bar is controlling: the one that is sounding, or — when nothing is —
 * the one that was paused where it stood.
 *
 * Two passes rather than one, because a container's own `playing` flag goes false the moment its
 * only sound is paused: a sound actually playing must always win over a sound paused somewhere
 * else, whatever order the collection happens to be in.
 *
 * @returns {{container: Playlist, sound: PlaylistSound}|null}
 */
export function getActiveEntry() {
  // Music first. Music and an ambience routinely sound together (playback.js EXCLUSIVE_GROUPS),
  // and the transport's pause, skip and repeat are track-list controls — collection order used to
  // decide which of the two it showed. The sort is stable, so order is kept inside each rank.
  const music = [CONTAINER_KINDS.PLAYLIST, CONTAINER_KINDS.QUEUE];
  const rank = p => (music.includes(containerKindOf(p)) ? 0 : 1);
  const containers = game.playlists.filter(p => isContainer(p)).sort((a, b) => rank(a) - rank(b));
  for (const container of containers) {
    const sound = container.sounds.find(s => s.playing);
    if (sound) return { container, sound };
  }
  for (const container of containers) {
    const sound = container.sounds.find(isPaused);
    if (sound) return { container, sound };
  }
  return null;
}

/* -------------------------------------------- */
/*  Macros                                      */
/* -------------------------------------------- */

/**
 * The module's folder in the Macro sidebar — where a pad dragged onto the hotbar leaves its
 * macro. Same rule as the section folders: the flag identifies it, so a GM may rename it or drag
 * it elsewhere without stranding anything.
 * @returns {Folder|null} Null until the first pad has been dragged to the hotbar.
 */
export function getMacroFolder() {
  return game.folders.find(f => (f.type === "Macro") && !!f.getFlag(MODULE_ID, FLAGS.MACRO_FOLDER)) ?? null;
}

/**
 * The macro already made for an audio file, if there is one. The path is the whole identity test:
 * two pads on the same file — on one board or on three — share a single macro rather than
 * littering the directory with copies of the same three lines.
 *
 * Searched across all macros rather than the module folder's contents, so a macro the GM dragged
 * out of that folder is still found instead of being silently duplicated.
 * @param {string} path
 * @returns {Macro|null}
 */
export function findMacroForPath(path) {
  const wanted = normalizePath(path);
  if (!wanted) return null;
  return game.macros.find(m => normalizePath(m.getFlag(MODULE_ID, FLAGS.SOUND_PATH) ?? "") === wanted) ?? null;
}
