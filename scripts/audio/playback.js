/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { CONTAINER_KINDS, MODULE_ID } from "../constants.js";
import { canWrite, normalizePath } from "../helpers.js";
import { containerKindOf, getContainers, getEntries, getQueue, isOn, isPaused } from "../data/repository.js";
import { clearContainer, createEntries } from "../data/mutations.js";
import { buildContainerFlags, readContainerFlags, readEntryFlags } from "../data/flag-models.js";

// Broadcast. Everything here is a native document operation, which IS Foundry's audio broadcast
// system: the update propagates to every client and each client's PlaylistSound#sync() reacts to
// it. There is no socket anywhere in this module and there must never be one — reimplementing
// document propagation over game.socket would be strictly worse.
//
// This module never touches the DOM and holds no state of its own.

// Broadcasting is a document write, so it is GM-only — helpers.js canWrite() is the gate.
const canBroadcast = canWrite;

// Playback is exclusive within a category: starting one member stops whatever else of that
// category is sounding or paused. Music (playlists and the Now Playing queue, which is where a
// library track plays) and ambiences are separate categories, so a music track and an ambience bed
// still layer — that is the common case at a table. Soundboards belong to none: a pad is a one-off
// over everything else. The paused member is stopped outright, bookmark and all: a paused track
// left behind in another container is what the transport would otherwise fall back to showing.
const EXCLUSIVE_GROUPS = [
  [CONTAINER_KINDS.PLAYLIST, CONTAINER_KINDS.QUEUE],
  [CONTAINER_KINDS.AMBIENCE]
];

/**
 * @param {Playlist} container
 * @returns {boolean} Whether anything in it is sounding or parked mid-track.
 */
function isSounding(container) {
  return isOn(container) || container.sounds.some(s => s.playing || isPaused(s));
}

/**
 * Stop the other members of a container's exclusive group. Awaited before the play it precedes, so
 * the two never overlap at the table.
 * @param {Playlist} container The one about to play; never stopped here.
 * @returns {Promise<void>}
 */
async function stopRivals(container) {
  const group = EXCLUSIVE_GROUPS.find(kinds => kinds.includes(containerKindOf(container)));
  if (!group) return;
  const rivals = group.flatMap(kind => getContainers(kind))
    .filter(c => (c.id !== container.id) && isSounding(c));
  await Promise.all(rivals.map(c => stopContainer(c)));
}

/* -------------------------------------------- */
/*  Native wrappers                             */
/* -------------------------------------------- */

/**
 * Play a whole container from the top — an ambience, or a playlist.
 * @param {Playlist} container
 * @returns {Promise<Playlist|void>}
 */
export async function playContainer(container) {
  if (!container || !canBroadcast("playContainer")) return;
  await stopRivals(container);
  if (containerKindOf(container) === CONTAINER_KINDS.AMBIENCE) return startAmbience(container);
  return container.playAll();
}

/**
 * An ambience's own playAll: the beds start, and of the random-interval layers only those marked to play
 * on start. The rest are left to random-scheduler.js, which spreads their first fires across their
 * first interval when it sees the ambience come on.
 *
 * The same single write core's playAll makes for a SIMULTANEOUS playlist (v14.368), with the
 * sounds that should stay quiet left out of it, and the `active` flag set in the same write.
 * @param {Playlist} container
 * @returns {Promise<Playlist>}
 */
function startAmbience(container) {
  const starts = container.sounds.filter(s => {
    const { random } = readEntryFlags(s);
    return !random.enabled || random.onStart;
  });
  return container.update({
    playing: true,
    sounds: starts.map(s => ({ _id: s.id, playing: true })),
    flags: { [MODULE_ID]: buildContainerFlags({ ...readContainerFlags(container), active: true }) }
  });
}

/**
 * Play one entry — a track, or a soundboard pad.
 * @param {Playlist} container
 * @param {PlaylistSound} sound
 * @returns {Promise<Playlist|void>}
 */
export async function playEntry(container, sound) {
  if (!container || !sound || !canBroadcast("playEntry")) return;
  await stopRivals(container);
  return container.playSound(sound);
}

/**
 * Stop a whole container.
 *
 * Not the native `Playlist#stopAll`: in v14.368 it writes `playing: false` per sound and leaves
 * `pausedTime` where it was (confirmed live), so a track that had been paused would still read as
 * paused — repository.js's isPaused() would keep handing it to the transport as the thing to
 * resume. A stop wants silence with no bookmark, so the batch here nulls the offset as well.
 * @param {Playlist} container
 * @returns {Promise<Playlist|void>}
 */
export async function stopContainer(container) {
  if (!container || !canBroadcast("stopContainer")) return;
  const update = {
    playing: false,
    sounds: container.sounds.map(s => ({ _id: s.id, playing: false, pausedTime: null }))
  };
  if (containerKindOf(container) === CONTAINER_KINDS.AMBIENCE) {
    update.flags = { [MODULE_ID]: buildContainerFlags({ ...readContainerFlags(container), active: false }) };
  }
  return container.update(update);
}

/**
 * @param {Playlist} container
 * @param {number} direction 1 forward, -1 back.
 * @returns {Promise<Playlist|void>}
 */
export async function advance(container, direction = 1) {
  if (!container || !canBroadcast("advance")) return;
  return container.playNext(undefined, { direction });
}

/**
 * Pause an entry where it stands. The idiom is confirmed against a live v14 world: pausedTime on
 * the document is the truth and resuming is just playSound() again. This module tracks no
 * position of its own.
 * @param {PlaylistSound} sound
 * @returns {Promise<PlaylistSound|void>}
 */
export async function pauseEntry(sound) {
  if (!sound || !canBroadcast("pauseEntry")) return;
  return sound.update({ playing: false, pausedTime: sound.sound?.currentTime ?? 0 });
}

/**
 * Stop one entry outright, as opposed to parking it where it stands.
 *
 * `pausedTime: null` is the difference from pauseEntry() and it is load-bearing: repository.js's
 * getActiveEntry() reads a finite pausedTime as "this is the paused track the transport should be
 * controlling", so a stop that left an offset behind would hand the transport bar a track nobody
 * stopped on purpose. Added for automation's release path — a state rule letting go of what it
 * started wants silence, not a bookmark.
 * @param {PlaylistSound} sound
 * @returns {Promise<PlaylistSound|void>}
 */
export async function stopEntry(sound) {
  if (!sound || !canBroadcast("stopEntry")) return;
  return sound.update({ playing: false, pausedTime: null });
}

/**
 * Resume from pausedTime. Native — there is no stored offset to feed back in.
 * @param {Playlist} container
 * @param {PlaylistSound} sound
 * @returns {Promise<Playlist|void>}
 */
export async function resumeEntry(container, sound) {
  return playEntry(container, sound);
}

/**
 * Move a broadcast track's playhead.
 *
 * There is no seek in Foundry's playlist API, and there does not need to be one: pausedTime on the
 * document *is* the offset PlaylistSound#sync() hands to Sound#play when it starts a track, and
 * Playlist#playSound deliberately preserves the pausedTime of the sound it is starting while
 * nulling every other one (both confirmed in v14.365, client/documents/playlist-sound.mjs and
 * playlist.mjs). So a seek is exactly the pause/resume pair above with a chosen offset in place of
 * the live currentTime, and every client re-syncs through the document propagation it already
 * does — no socket, no second source of truth.
 *
 * The two writes cannot be collapsed into one. sync() only applies an offset on the branch that
 * *starts* a Sound; a sound that is already playing takes the "update an already playing sound"
 * branch, where nothing but volume and loop is touched and the offset is ignored.
 *
 * @param {Playlist} container
 * @param {PlaylistSound} sound
 * @param {number} seconds
 * @returns {Promise<void>}
 */
export async function seekEntry(container, sound, seconds) {
  if (!container || !sound || !canBroadcast("seekEntry")) return;
  // pausedTime is a NumberField: a NaN offset is rejected with a DataModelValidationError deep
  // inside the update rather than ignored, so it is refused here where the reason is legible.
  if (!Number.isFinite(seconds)) return;
  const resume = !!sound.playing;
  await sound.update({ playing: false, pausedTime: Math.max(0, seconds) });
  if (resume) await playEntry(container, sound);
}

/**
 * Set an entry's volume. PlaylistSound#debounceVolume is native and coalesces the writes a slider
 * drag produces, which is exactly why nothing here hand-rolls a debounce around update({volume}).
 * Synchronous on purpose: the write it schedules is not ours to await.
 * @param {PlaylistSound} sound
 * @param {number} volume 0–1 gain, already through AudioHelper.inputToVolume().
 */
export function setEntryVolume(sound, volume) {
  if (!sound || !canBroadcast("setEntryVolume")) return;
  sound.debounceVolume(Math.clamp(volume, 0, 1));
}

/**
 * Stop every module container that is sounding or holds a paused track. One update per such
 * container, batched across its sounds — in practice one or two containers, never the world.
 *
 * `isPaused`, not `pausedTime !== null`: a never-played sound has the field *unset*, and the older
 * comparison selected every container with one of those, which sent a write to nearly every
 * container in the world on each Stop.
 *
 * This deliberately does not empty the queue: Now Playing is a running order the GM built, and
 * silencing the table must not throw it away. Bootstrap clears it on world load and the section
 * has its own Clear.
 *
 * @returns {Promise<number>} How many containers were stopped.
 */
export async function stopEverything() {
  if (!canBroadcast("stopEverything")) return 0;
  const sounding = allContainers().filter(isSounding);
  await Promise.all(sounding.map(c => stopContainer(c)));
  return sounding.length;
}

/**
 * Every module container, queue included.
 * @returns {Playlist[]}
 */
function allContainers() {
  return Object.values(CONTAINER_KINDS).flatMap(kind => getContainers(kind));
}

/* -------------------------------------------- */
/*  The Now Playing queue                       */
/* -------------------------------------------- */

/**
 * A PlaylistSound creation spec for a library entry. Shared by the Now Playing queue and the
 * "add from library" / "add to" flows, so the channel-routing rule lives in exactly one place:
 * the channel is the entry's own, never the container's.
 * @param {object} entry A library row from library/index.js.
 * @returns {{name: string, path: string, volume: number, channel: string}}
 */
export function soundSpecFor(entry) {
  return {
    name: entry.name,
    path: entry.path,
    volume: entry.volume,
    channel: entry.channel
  };
}

/**
 * A library entry is a path, not a document, so broadcasting one needs a PlaylistSound to exist
 * for as long as it plays. One scratch container holds them all, which keeps the native Playlists
 * tab at exactly one extra playlist however large the library grows.
 *
 * @param {object} entry A library row from library/index.js.
 * @returns {Promise<PlaylistSound|null>} The queue entry, created or reused.
 */
export async function appendToQueue(entry) {
  const queue = getQueue();
  if (!entry || !queue || !canBroadcast("appendToQueue")) return null;

  // Re-use rather than duplicate: playing the same track twice in a session would otherwise leave
  // two identical rows for next/previous to walk through. This dedupe is queue-specific — an
  // ordinary playlist may legitimately hold the same track more than once.
  const existing = getEntries(queue).find(s => normalizePath(s.path) === normalizePath(entry.path));
  if (existing) return existing;

  const [created] = await createEntries(queue, [soundSpecFor(entry)]);
  return created ?? null;
}

/**
 * Play a library track for the table: put it in the queue, then play it. Queued siblings stay,
 * so SEQUENTIAL mode advances into them and next/previous have somewhere to go.
 * @param {object} entry A library row.
 * @returns {Promise<PlaylistSound|null>} The queue entry that is now playing.
 */
export async function playLibraryTrack(entry) {
  const sound = await appendToQueue(entry);
  if (!sound) return null;
  await playEntry(getQueue(), sound);
  return sound;
}

/**
 * Empty the queue. Called on world load via bootstrap, and from the Now Playing section's own
 * Clear button.
 * @returns {Promise<PlaylistSound[]>}
 */
export function clearQueue() {
  const queue = getQueue();
  return queue ? clearContainer(queue) : Promise.resolve([]);
}
