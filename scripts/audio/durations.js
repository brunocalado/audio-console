/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { normalizePath, toFetchUrl } from "../helpers.js";

// How long a track runs, for lists that show it. Read once per path per session and remembered,
// because the answer cannot change without the file changing.
//
// Deliberately an HTMLAudioElement with `preload="metadata"` rather than foundry.audio.Sound: a
// Sound decodes the whole file into an AudioBuffer, which is the right thing when it is about to
// be played and far too much when the only question is a number of seconds. Metadata preload
// fetches the header and stops — which is also why this is affordable in a playlist of tens of
// entries while the library table, at a few thousand, still deliberately has no duration column
// (console-base.js #paintProgress says the same thing from the other side).
//
// Nothing here touches the AudioContext, so it needs no user gesture and cannot make a sound.

/** @type {Map<string, number|null>} normalised path -> seconds, or null when it could not be read. */
const durations = new Map();

/** @type {Map<string, Promise<number|null>>} In-flight probes, so N rows for one path cost one fetch. */
const pending = new Map();

// A metadata read that never settles would otherwise hold its entry in `pending` for the session
// and every later caller with it. Long enough not to trip on a slow first byte over a LAN share.
const PROBE_TIMEOUT_MS = 15000;

// Chrome caps how many WebMediaPlayers one renderer may hold at a time (~75, crbug.com/1144736#c27)
// and counts every HTMLMediaElement against it, playing or not. Asking for one probe per row in a
// single frame is exactly how that cap is hit: "Add from Library" onto a playlist of a few hundred
// tracks re-rendered the section, #fillDurations (console-normal.js) asked for every unread
// duration at once, and everything past the cap was refused outright — one
// "Blocked attempt to create a WebMediaPlayer" per row in the console, and no duration for any of
// the rows that were refused, because a blocked element never fires loadedmetadata *or* error and
// so sat there until the timeout above.
//
// So probes take turns. Well under the cap rather than just below it, because playback needs
// players out of the same budget. Measured on a 300-row playlist over a LAN share: ungated peaked
// at 300 live elements at once (the bug); 6 at a time drained in 22s, 12 in 13s, with no run ever
// exceeding its own ceiling.
const MAX_ACTIVE_PROBES = 12;

/** @type {Array<() => void>} Probes that have a caller waiting but no slot yet. */
const queued = [];

/** @type {number} How many <audio> elements this module currently has in flight. */
let activeProbes = 0;

/** Start as many queued probes as the budget allows. Cheap to call; a no-op when full or empty. */
function pump() {
  while ((activeProbes < MAX_ACTIVE_PROBES) && queued.length) {
    activeProbes++;
    queued.shift()();
  }
}

/**
 * The duration already known for this path, without starting a read.
 * @param {string} path
 * @returns {number|null|undefined} Seconds, `null` if a read failed, `undefined` if never read.
 */
export function knownDuration(path) {
  return durations.get(normalizePath(path));
}

/**
 * Read (or recall) how long a file runs.
 * @param {string} path A stored (possibly percent-encoded) path.
 * @returns {Promise<number|null>} Seconds, or null if the file could not be read.
 */
export function probeDuration(path) {
  const key = normalizePath(path);
  if (durations.has(key)) return Promise.resolve(durations.get(key));
  if (pending.has(key)) return pending.get(key);

  // The element is created when a slot frees up, not when the caller asks — the caller gets its
  // promise either way, and the timeout below only starts once the read actually does.
  const probe = new Promise(resolve => {
    queued.push(() => {
      const audio = new Audio();
      audio.preload = "metadata";
      let done = false;
      const settle = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Dropping the src is what lets the browser abandon a still-running request and hand the
        // player back; without it a folder of unreachable paths leaves one live loader each, and
        // each of those holds a slot of the budget for the rest of the session.
        audio.removeAttribute("src");
        audio.load();
        durations.set(key, value);
        pending.delete(key);
        activeProbes--;
        resolve(value);
        pump();
      };
      const timer = setTimeout(() => settle(null), PROBE_TIMEOUT_MS);
      // A stream with no known length reports Infinity, which is not a duration anyone can render.
      audio.addEventListener("loadedmetadata", () => settle(Number.isFinite(audio.duration) ? audio.duration : null), { once: true });
      audio.addEventListener("error", () => settle(null), { once: true });
      // The stored form may already carry %20; toFetchUrl decodes before re-encoding so an encoded
      // and a raw path converge instead of turning into %2520 and a 404.
      audio.src = toFetchUrl(path);
    });
  });

  pending.set(key, probe);
  pump();
  return probe;
}

/** Forget everything read so far — for when files on disk may have been replaced. */
export function clearDurationCache() {
  durations.clear();
}
