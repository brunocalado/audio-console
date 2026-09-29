/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { CONTAINER_KINDS, MODULE_ID } from "../constants.js";
import { containerKindOf, getContainers } from "../data/repository.js";
import { updateContainers } from "../data/mutations.js";
import { playEntry, stopEntry } from "./playback.js";

// A soundboard the GM shares with the players: they can fire and stop its pads, and nothing else.
//
// "Shared" is the board's native ownership, not a flag of ours. OBSERVER is the level that lets a
// player read the board and nothing more; OWNER would also let them rename, reconfigure or delete
// it straight from core's Playlists sidebar. The console's toggle writes the default level, and a
// GM who wants one board for one player sets it per user in core's own Configure Ownership dialog —
// both are the same field, so the player's side needs one test for either.
//
// A player never writes the board. Firing a pad is a PlaylistSound update, which OBSERVER does not
// allow, so the player's client asks the active GM to do it (CONFIG.queries) and the GM plays it
// through playback.js like any pad fired from the console — ducking and every other reaction to a
// playing pad behave exactly as they do for the GM. The GM side re-checks everything the request
// claims: it arrives from another client, so it is a boundary.

const FIRE_QUERY = `${MODULE_ID}.fireSharedPad`;

/**
 * Whether the console's share toggle reads as on — the board's default level, which is what the
 * toggle writes. Per-user grants from core's dialog do not light it.
 * @param {Playlist} board
 * @returns {boolean}
 */
export function isShared(board) {
  return (board.ownership.default ?? 0) >= foundry.CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
}

/**
 * @param {Playlist} board
 * @param {boolean} shared
 * @returns {Promise<Playlist[]>}
 */
export function setShared(board, shared) {
  const { OBSERVER, NONE } = foundry.CONST.DOCUMENT_OWNERSHIP_LEVELS;
  return updateContainers([{ _id: board.id, ownership: { default: shared ? OBSERVER : NONE } }]);
}

/**
 * @param {User} user
 * @returns {Playlist[]} The soundboards this user may fire, sorted by name.
 */
export function boardsSharedWith(user) {
  return getContainers(CONTAINER_KINDS.SOUNDBOARD).filter(board => board.testUserPermission(user, "OBSERVER"));
}

/**
 * Ask the active GM to fire a pad, or to stop it if it is sounding. The GM decides which from the
 * pad's state on their side, so two players pressing the same pad at once cannot both start it.
 * @param {Playlist} board
 * @param {PlaylistSound} sound
 * @returns {Promise<void>}
 */
export async function requestPad(board, sound) {
  const gm = game.users.activeGM;
  if (!gm) {
    ui.notifications.warn("AUDIO_CONSOLE.Shared.Notify.NoGM", { localize: true });
    return;
  }
  try {
    await gm.query(FIRE_QUERY, { boardId: board.id, soundId: sound.id });
  } catch (err) {
    console.error(`${MODULE_ID} | the GM refused a shared pad`, err);
    ui.notifications.warn("AUDIO_CONSOLE.Shared.Notify.Failed", { localize: true });
  }
}

/**
 * The GM's side of requestPad. Throwing is how a query answers "no": core hands the message back
 * to the asking client as a rejection.
 * @param {{boardId: string, soundId: string}} data
 * @param {{user: User}} context The asking user, as the server identified them — not the payload.
 * @returns {Promise<void>}
 */
async function onFireSharedPad({ boardId, soundId } = {}, { user }) {
  const board = game.playlists.get(boardId);
  if ((containerKindOf(board) !== CONTAINER_KINDS.SOUNDBOARD) || !board.testUserPermission(user, "OBSERVER")) {
    throw new Error(`${user.name} has no shared soundboard ${boardId}`);
  }
  const sound = board.sounds.get(soundId);
  if (!sound) throw new Error(`soundboard ${boardId} has no pad ${soundId}`);
  if (sound.playing) await stopEntry(sound);
  else await playEntry(board, sound);
}

/** Registered on every client during `init`: a query must be known to be sent as well as answered. */
export function registerSharedBoards() {
  CONFIG.queries[FIRE_QUERY] = onFireSharedPad;
}
