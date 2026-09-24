/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { canWrite, effectiveChannel, toFetchUrl } from "../helpers.js";

// Sending one pad to one person, while the sender hears it too.
//
// This is the only place in the module that emits over a socket, and it is deliberately its own
// file rather than another function in playback.js — because it is the one thing document
// propagation cannot express. A PlaylistSound update reaches every client by design, so "only
// Player 2 hears this" has no document form at all. Core's AudioHelper.play is the mechanism: the
// server relays the "playAudio" event to the sockets of the users named in `recipients` and to
// nobody else (v14.367, dist/server/sockets.mjs handleCustomSocket), and core makes the same call
// itself for A/V signalling (client/av/clients/simplepeer.mjs).
//
// playback.js's "there is no socket anywhere in this module" rule is not bent by this. What that
// rule forbids is reimplementing *document propagation* over game.socket, which would be strictly
// worse than the document write it replaced. Nothing here propagates a document, module.json still
// declares "socket": false, and nothing emits on module.audio-console — this rides core's own
// event, on core's own listener.

/**
 * Who a pad can be sent to: everyone connected except the sender.
 *
 * Connected, not merely existing. A user who is not logged in has no socket for the server to
 * relay to, so listing them would be offering the GM a name that produces silence — and silence
 * that looks like a bug rather than like an absent player.
 *
 * @returns {User[]} Sorted by name, so the list does not reorder as people connect.
 */
export function whisperTargets() {
  return game.users
    .filter(user => user.active && (user.id !== game.user.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Play one entry to one user, and here at the same time.
 *
 * `AudioHelper.play` does both halves in one call: it emits to the named recipient and then plays
 * locally, because a socket emit never comes back to its own sender. That is exactly the ask —
 * the GM hears what they just sent.
 *
 * Volume and channel are the pad's own, so a whisper sounds like the pad does. Loop is *not*:
 * a looping pad sent this way would start a Sound on someone else's machine that this module has
 * no handle on and no way to stop, since the only thing that crossed was a fire-and-forget event.
 * A one-shot cue is what a soundboard whisper is for; an endless one is a support request.
 *
 * @param {PlaylistSound} sound A soundboard pad.
 * @param {string} userId The single recipient.
 * @returns {Promise<Sound>|null} The local Sound, or null when nothing was sent.
 */
export function whisperEntry(sound, userId) {
  if (!sound || !userId) return null;
  // Same gate playback.js puts on every broadcast: making noise on someone else's client is a GM
  // act, and the rule belongs with the code that could break it.
  if (!canWrite("whisperEntry")) return null;
  return foundry.audio.AudioHelper.play({
    // toFetchUrl, not the stored path: the same %2520 trap preview.js documents applies to any
    // path this module hands to AudioHelper rather than to a PlaylistSound.
    src: toFetchUrl(sound.path),
    channel: effectiveChannel(sound),
    volume: Math.clamp(sound.volume ?? 1, 0, 1),
    loop: false
  }, { recipients: [userId] });
}
