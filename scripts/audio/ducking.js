/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { CONTAINER_KINDS, DUCK_FACTOR, DUCK_RAMP_S } from "../constants.js";
import { readContainerFlags } from "../data/flag-models.js";
import { getContainers, isContainer, isEntry } from "../data/repository.js";

// Lower the music channel while a pad from a ducking soundboard sounds, and bring it back when
// the last one stops.
//
// Local to every client, GM and player alike. Core sets each client's music volume straight onto
// `game.audio.music.gainNode` (the core.globalPlaylistVolume setting's onChange, v14.368), so the
// duck is that same node ramped to the client's own volume times DUCK_FACTOR. Nothing is written
// to any document: the PlaylistSound updates that start and stop a pad already reach every client,
// and each one reacts to them here. The GM's levels — pad, layer, track volumes — are never
// touched, which is what makes the toggle safe to flip mid-session.

let registered = false;

/** @returns {boolean} Whether any pad of any ducking soundboard is playing right now. */
function shouldDuck() {
  return getContainers(CONTAINER_KINDS.SOUNDBOARD)
    .some(board => readContainerFlags(board).duck && board.sounds.some(sound => sound.playing));
}

/**
 * Ramp the music channel to where it should be now. Safe to call at any time and any number of
 * times: the target is computed from scratch, and ramping to the value already set is a no-op.
 *
 * `game.audio.music` is null until the AudioContext is unlocked by a gesture; before that there is
 * nothing to duck and nothing playing to duck under.
 */
export function applyDucking() {
  const context = game.audio.music;
  if (!context?.gainNode) return;
  const base = Math.clamp(game.settings.get("core", "globalPlaylistVolume") ?? 1, 0, 1);
  const target = shouldDuck() ? base * DUCK_FACTOR : base;
  const gain = context.gainNode.gain;
  // cancel first: a ramp still in flight from the previous change must not run to its old end.
  gain.cancelScheduledValues(context.currentTime);
  gain.setValueAtTime(gain.value, context.currentTime);
  gain.linearRampToValueAtTime(target, context.currentTime + DUCK_RAMP_S);
}

/**
 * Wire the hooks. Every client calls this on ready — the pad's `playing` flag arrives here as a
 * PlaylistSound update, and the board's own toggle as a Playlist update.
 */
export function initDucking() {
  if (registered) return;
  registered = true;
  const Hooks = foundry.helpers.Hooks;
  for (const hook of ["createPlaylistSound", "updatePlaylistSound", "deletePlaylistSound"]) {
    Hooks.on(hook, sound => { if (isEntry(sound)) applyDucking(); });
  }
  for (const hook of ["updatePlaylist", "deletePlaylist"]) {
    Hooks.on(hook, playlist => { if (isContainer(playlist)) applyDucking(); });
  }
  // Core writes the raw slider value onto the node before firing this; re-apply the factor on top.
  Hooks.on("globalPlaylistVolumeChanged", () => applyDucking());
  applyDucking();
}
