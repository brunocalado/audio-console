/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { DEFAULT_CHANNEL } from "../constants.js";
import { normalizePath, toFetchUrl } from "../helpers.js";

// Preview is GM-only auditioning. Nothing here reaches the database, so nothing here reaches the
// players — confirmed against a live world with a connected player.
//
// The second argument to AudioHelper.play() is the socket option. We only ever pass `false`.
// `true` broadcasts to everyone, which is the document path's job. If `true` ever appears in this
// module, it is a bug.

/** @type {Map<string, foundry.audio.Sound>} normalised path -> the Sound auditioning it. */
const previews = new Map();

/**
 * Audition a file locally.
 * @param {string} path A stored (possibly percent-encoded) path.
 * @param {{volume?: number, loop?: boolean, channel?: string}} [options]
 * @returns {Promise<foundry.audio.Sound|null>}
 */
export async function preview(path, { volume = 0.7, loop = false, channel = DEFAULT_CHANNEL } = {}) {
  if (!path) return null;
  const key = normalizePath(path);
  await stopPreview(key);

  const sound = await foundry.audio.AudioHelper.play({
    // The stored form may already carry %20. toFetchUrl decodes before re-encoding so an encoded
    // and a raw path converge instead of turning into %2520 and a 404.
    src: toFetchUrl(path),
    volume: Math.clamp(volume, 0, 1),
    loop,
    channel
  }, false);

  if (!sound) return null;
  previews.set(key, sound);

  // A preview Sound belongs to no document, so nobody else will ever clean it up. Dropping it
  // when it ends on its own is what keeps the registry from growing for a session.
  sound.addEventListener("end", () => {
    if (previews.get(key) === sound) previews.delete(key);
  }, { once: true });

  return sound;
}

/**
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function stopPreview(path) {
  const key = normalizePath(path);
  const sound = previews.get(key);
  if (!sound) return;
  previews.delete(key);
  await sound.stop();
}

/**
 * Move the playhead of whatever is currently being auditioned.
 *
 * A Sound has no seek of its own. `offset` is only read by Sound#play when playback *starts*, and
 * while one is paused #configurePlayback *adds* pausedTime to whatever offset is passed rather
 * than replacing it (confirmed in v14.365 client/audio/sound.mjs) — so passing an offset to a
 * live Sound does nothing and passing one to a paused Sound lands in the wrong place. A seek is
 * therefore stop-then-play at the new offset, with two things that must be carried across by
 * hand: Sound#stop defaults its own `volume` option to 0 and that value survives into the next
 * play(), and loop is not re-derived from anything.
 *
 * A paused preview is never restarted here. pausedTime is exactly what the next play() reads, so
 * writing it is the whole seek — resuming then picks up at the new position instead of jumping
 * back to where it was paused. Note that stop() disconnects the buffer node's `onended` before
 * stopping, so this never fires the `end` event preview() registered, and the registry entry
 * survives the round trip.
 *
 * @param {number} seconds Clamped to the Sound's own duration.
 * @returns {Promise<void>}
 */
export async function seek(seconds) {
  const active = getActive();
  if (!active || !Number.isFinite(seconds)) return;
  const { sound } = active;
  const duration = sound.duration;
  const target = Math.clamp(seconds, 0, Number.isFinite(duration) ? duration : seconds);

  if (!sound.playing) {
    sound.pausedTime = target;
    return;
  }
  const volume = sound.volume;
  const loop = sound.loop;
  await sound.stop({ fade: 0 });
  await sound.play({ offset: target, volume, loop });
}

/**
 * Stop everything being auditioned. Called on the console's _onClose and whenever the mode
 * switches to broadcast, so nothing double-plays in the GM's headphones.
 * @returns {Promise<void>}
 */
export async function stopAll() {
  const sounds = [...previews.values()];
  previews.clear();
  await Promise.all(sounds.map(s => s.stop()));
}

/**
 * The preview the transport bar should show. Registry membership is the truth: a Sound is added
 * when it starts and removed when it stops or ends, so a paused one is still here and can be
 * resumed. Only a Sound that failed to load is swept, since it will never fire `end`.
 * @returns {{path: string, sound: foundry.audio.Sound}|null}
 */
export function getActive() {
  for (const [path, sound] of previews) {
    if (sound.failed) {
      previews.delete(path);
      continue;
    }
    return { path, sound };
  }
  return null;
}

/** @returns {number} How many previews the registry holds. The leak check reads this. */
export function activeCount() {
  return previews.size;
}

/** @returns {string[]} Normalised paths currently in the registry. */
export function activePaths() {
  return [...previews.keys()];
}
