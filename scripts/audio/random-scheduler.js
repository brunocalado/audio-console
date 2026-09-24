/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { CONTAINER_KINDS, FLAGS, MODULE_ID } from "../constants.js";
import { containerKindOf, getContainers, getEntries } from "../data/repository.js";
import { onContainerChange } from "../data/sync.js";
import { buildContainerFlags, readContainerFlags, readEntryFlags } from "../data/flag-models.js";
import * as playback from "./playback.js";

// Soundboard pads and random-interval ambience layers fire on a randomised timer whose
// config lives in the entry's own flags. One scheduler runs in the whole world: the active-GM
// guard is what stops every connected GM's client from independently timing the same pad and
// producing N duplicate playSound() writes per cycle.
//
// Scanning every container kind rather than soundboards only is deliberate: EntryFlags.random is a
// generic entry field, not a soundboard-specific one, so an ambience layer on a random interval is
// picked up here with no scheduler of its own.
//
// What differs by kind is *when* a timer may play. A soundboard pad is its own switch: the GM
// turning random on is the request to hear it. An ambience layer is part of a bed, so it only
// fires while that ambience is switched on (its `active` flag) — see fire(). Without that gate every random layer of
// every ambience in the world fires on its own clock, and a pack that ships hundreds of ambiences
// (tabletop-audio: 230 of them, 2260 random layers) turns into dozens of sounds nobody started.

// Floor the delay regardless of what the config says. EntryFlags.interval already clamps to a 2s
// minimum on its own, but variance can still pull the *computed* delay below that; this is the
// belt-and-suspenders floor on the delay itself, so a mistyped 0 or a small interval with wide
// variance cannot become a playback loop that hammers the database.
const MIN_DELAY_S = 2;

// Debounced so a burst of structural changes (a bulk "add pads from library", several drags in a
// row) collapses into one rebuild rather than tearing down and rebuilding every timer once per
// change.
const REFRESH_DEBOUNCE_MS = 250;

/**
 * A monotonically increasing token. Every scheduled timeout captures the generation it was armed
 * under and compares it against the live value before acting, so a timer that outlived the config
 * it was scheduled from — because a pad was reconfigured or deleted, a soundboard was deleted, the
 * scheduler was stopped, or the active GM changed — dies quietly instead of firing on stale data.
 */
let generation = 0;

/** @type {Map<string, number>} PlaylistSound id -> setTimeout handle. */
const timers = new Map();

/** Every container this scheduler considers, regardless of kind — see the module doc comment. */
function scheduledContainers() {
  return Object.values(CONTAINER_KINDS).flatMap(kind => getContainers(kind));
}

/**
 * Seconds until the next fire: interval × (1 ± variance), uniform across the window and floored.
 * Uniform rather than a fixed period with jitter bolted on, so the cadence actually reads as
 * irregular.
 * @param {{interval: number, variance: number}} random
 * @returns {number} Milliseconds.
 */
function computeDelay({ interval, variance }) {
  const span = interval * variance;
  const seconds = interval + ((Math.random() * 2) - 1) * span;
  return Math.max(seconds, MIN_DELAY_S) * 1000;
}

/**
 * Stop every pending timer and invalidate whatever is already in flight. Safe to call from
 * anywhere, any number of times — this is also what a non-active GM's start() reduces to.
 */
export function stop() {
  generation++;
  for (const id of timers.values()) clearTimeout(id);
  timers.clear();
}

/**
 * Rebuild every timer from the current flags. Always stops first, so it is safe to call directly
 * as well as through the debounced refresh() without ever stacking a second timer for the same
 * pad.
 */
export function start() {
  stop();
  if (!game.user.isActiveGM) return;
  const gen = generation;
  for (const container of scheduledContainers()) {
    for (const sound of getEntries(container)) {
      if (readEntryFlags(sound).random.enabled) scheduleNext(gen, container.id, sound.id);
    }
  }
}

/** Debounced stop+start — see initRandomScheduler() for what triggers it. */
export const refresh = foundry.utils.debounce(start, REFRESH_DEBOUNCE_MS);

/**
 * Arm the next fire for one entry. Re-resolves the container and sound by id and re-reads the
 * flag fresh rather than trusting what the caller already had in hand — a GM can reconfigure the
 * interval in the gap between one fire and the next schedule, and rule 4's "read config on every
 * fire" is honoured here too, not only inside the fire callback below.
 * @param {number} gen
 * @param {string} containerId
 * @param {string} soundId
 * @param {number} [delay] Milliseconds, in place of the usual interval × (1 ± variance).
 */
function scheduleNext(gen, containerId, soundId, delay) {
  if (gen !== generation) return;
  const container = game.playlists.get(containerId);
  const sound = container?.sounds.get(soundId);
  if (!container || !sound) return; // pad or soundboard deleted
  const { random } = readEntryFlags(sound);
  if (!random.enabled) return; // turned off since the last schedule

  const timeoutId = setTimeout(() => fire(gen, containerId, soundId), delay ?? computeDelay(random));
  timers.set(soundId, timeoutId);
}

/**
 * A timer landed. Rule 7: a pad already sounding is skipped rather than fired over — the cycle
 * still continues on schedule, it just does not play a second time on top of itself.
 * @param {number} gen
 * @param {string} containerId
 * @param {string} soundId
 */
function fire(gen, containerId, soundId) {
  timers.delete(soundId);
  if (gen !== generation) return; // superseded — this timer is a ghost
  if (!game.user.isActiveGM) return; // lost the role since scheduling; refresh() will pick it up

  const container = game.playlists.get(containerId);
  const sound = container?.sounds.get(soundId);
  if (!container || !sound) return;
  const { random } = readEntryFlags(sound);
  if (!random.enabled) return; // disabled meanwhile — do not reschedule

  // The cycle keeps running while the ambience is stopped, so pressing Play picks it up without a
  // rebuild — the timers are cheap, the playSound() write they would otherwise make is not.
  // The flag, not `playing`: see ContainerFlags.active.
  const live = (containerKindOf(container) !== CONTAINER_KINDS.AMBIENCE) || readContainerFlags(container).active;
  if (live && !sound.playing) playback.playEntry(container, sound);
  scheduleNext(gen, containerId, soundId);
}

/**
 * An ambience just came on: restart its random layers' cycles from now. A layer that played on
 * start (random.onStart) waits a full interval like after any fire; the others take their first
 * fire anywhere inside their first interval, so they come in spread out rather than all at the
 * start, or all a whole cycle later.
 * @param {Playlist} container
 */
function restartAmbience(container) {
  if (!game.user.isActiveGM) return;
  const gen = generation;
  for (const sound of getEntries(container)) {
    const { random } = readEntryFlags(sound);
    if (!random.enabled) continue;
    clearTimeout(timers.get(sound.id));
    const first = random.onStart ? undefined : Math.max(Math.random() * random.interval, MIN_DELAY_S) * 1000;
    scheduleNext(gen, container.id, sound.id, first);
  }
}

/**
 * Keep an ambience's `active` flag in step with starts and stops that did not come through
 * playback.js, and restart its random cycles whenever it comes on. Only the active GM writes.
 *
 * - The flag turning on is playback.js's startAmbience(), or the native-start case below.
 * - `playing` turning on with the flag still off is a start from somewhere else — the native
 *   Playlists tab — so the flag follows it.
 * - `playing` turning off with the flag still on is a native stop, but only if the ambience has a
 *   bed: an ambience of random layers alone goes quiet between fires all by itself, and that is not a
 *   stop. playback.js's stopContainer() clears the flag in the same write, so it never gets here.
 * @param {Playlist} playlist
 * @param {object} changed
 */
function onAmbienceUpdate(playlist, changed) {
  if (!game.user.isActiveGM || (containerKindOf(playlist) !== CONTAINER_KINDS.AMBIENCE)) return;
  const flags = readContainerFlags(playlist);
  const setActive = active => playlist.update({ flags: { [MODULE_ID]: buildContainerFlags({ ...flags, active }) } });
  if (foundry.utils.getProperty(changed, `flags.${MODULE_ID}.${FLAGS.ACTIVE}`) === true) restartAmbience(playlist);
  else if ((changed.playing === true) && !flags.active) setActive(true);
  else if ((changed.playing === false) && flags.active
    && playlist.sounds.some(s => !readEntryFlags(s).random.enabled)) setActive(false);
}

let initialized = false;

/**
 * Wire the scheduler into the world: build the initial set of timers, then rebuild them whenever
 * a module document changes structurally (a pad added, removed, or reconfigured; a soundboard
 * deleted) or a user's connection state changes (rule 2's "re-evaluate when a GM disconnects").
 * Call once, on ready, from every GM client — the guard inside start() is what keeps only the
 * active one actually scheduling anything.
 */
export function initRandomScheduler() {
  if (initialized) return;
  initialized = true;
  onContainerChange(refresh);
  // userConnected fires for any user's connection change, GM or not; refresh() is a cheap no-op
  // in the common case where nothing it schedules from actually changed.
  foundry.helpers.Hooks.on("userConnected", refresh);
  foundry.helpers.Hooks.on("updatePlaylist", onAmbienceUpdate);
  start();
}
