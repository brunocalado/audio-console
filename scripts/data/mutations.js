/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID, CONTAINER_KINDS, FLAGS, FOLDER_NAMES, MACRO_FOLDER_COLOR } from "../constants.js";
import { buildContainerFlags, buildEntryFlags, buildSectionFlags } from "./flag-models.js";
import { getEntries } from "./repository.js";
import { canWrite } from "../helpers.js";

// The only module that calls create/update/delete on a document. Everything here is batched:
// a per-document loop is a round-trip and a re-render per item, and playAll() on a twenty-layer
// ambience is exactly the case that punishes it.

/* -------------------------------------------- */
/*  Section folders                             */
/* -------------------------------------------- */

/**
 * @param {{section: string, name: string, parent?: string|null}[]} specs
 * @returns {Promise<Folder[]>}
 */
export async function createSectionFolders(specs) {
  if (!specs.length || !canWrite("folder creation")) return [];
  return foundry.documents.Folder.implementation.createDocuments(specs.map(spec => ({
    name: spec.name,
    type: "Playlist",
    folder: spec.parent ?? null,
    flags: { [MODULE_ID]: buildSectionFlags({ section: spec.section }) }
  })));
}

/* -------------------------------------------- */
/*  Containers                                  */
/* -------------------------------------------- */

/**
 * @param {{name: string, kind: string, color?: string|null, mode?: number, folder?: string|null,
 *   pack?: {id: string, key: string}|null, sounds?: object[]}[]} specs `pack` and `sounds` are set
 *   by api.js alone: a content module's container, built with its entries embedded in the one
 *   create — a pack of several hundred containers is one round-trip each rather than two. The
 *   console never passes either. Entry specs take the shape createEntries() takes.
 * @returns {Promise<Playlist[]>}
 */
export async function createContainers(specs) {
  if (!specs.length || !canWrite("container creation")) return [];
  return foundry.documents.Playlist.implementation.createDocuments(specs.map(spec => ({
    name: spec.name,
    mode: spec.mode ?? defaultModeFor(spec.kind),
    folder: spec.folder ?? null,
    flags: { [MODULE_ID]: buildContainerFlags({ kind: spec.kind, color: spec.color ?? null, pack: spec.pack ?? null }) },
    sounds: (spec.sounds ?? []).map(entrySpecWithFlags)
  })));
}

/** @param {{flags?: object}} spec @returns {object} The entry create data, flags built. */
function entrySpecWithFlags(spec) {
  return { ...spec, flags: { [MODULE_ID]: buildEntryFlags(spec.flags ?? {}) } };
}

/**
 * A soundboard is a SIMULTANEOUS playlist we never call playAll() on — there is no SOUNDBOARD
 * mode in Foundry, and firing pads individually is what makes it a soundboard.
 * @param {string} kind
 * @returns {number}
 */
function defaultModeFor(kind) {
  const modes = foundry.CONST.PLAYLIST_MODES;
  switch (kind) {
    case CONTAINER_KINDS.SOUNDBOARD:
    case CONTAINER_KINDS.AMBIENCE:
      return modes.SIMULTANEOUS;
    default:
      return modes.SEQUENTIAL;
  }
}

/**
 * The Now Playing queue. Its own function because bootstrap must be able to recreate exactly one.
 * @param {string|null} folder
 * @returns {Promise<Playlist|undefined>}
 */
export async function createQueue(folder = null) {
  const [queue] = await createContainers([{
    name: FOLDER_NAMES.QUEUE,
    kind: CONTAINER_KINDS.QUEUE,
    mode: foundry.CONST.PLAYLIST_MODES.SEQUENTIAL,
    folder
  }]);
  return queue;
}

/**
 * @param {object[]} updates Each carries an _id.
 * @returns {Promise<Playlist[]>}
 */
export async function updateContainers(updates) {
  if (!updates.length || !canWrite("container update")) return [];
  return foundry.documents.Playlist.implementation.updateDocuments(updates);
}

/**
 * Delete permanently — gone from Foundry entirely, sounds included.
 * @param {Playlist[]} containers
 * @returns {Promise<Playlist[]>}
 */
export async function deleteContainers(containers) {
  if (!containers.length || !canWrite("container deletion")) return [];
  return foundry.documents.Playlist.implementation.deleteDocuments(containers.map(c => c.id));
}

/**
 * Remove from Audio Console without deleting: drop the whole module flag scope and move the
 * document out of the module folder. It stays in the native Playlists tab with its sounds.
 * @param {Playlist[]} containers
 * @returns {Promise<Playlist[]>}
 */
export async function releaseContainers(containers) {
  if (!containers.length || !canWrite("container release")) return [];
  return foundry.documents.Playlist.implementation.updateDocuments(containers.map(c => ({
    _id: c.id,
    folder: null,
    // Deleting a field is an operator in v14, not a "-=" key prefix: the old syntax still works
    // but logs a deprecation warning and goes away in v16. ForcedDeletion's constructor argument
    // is ignored — it takes one only so every operator shares a signature.
    flags: { [MODULE_ID]: new foundry.data.operators.ForcedDeletion() }
  })));
}

/* -------------------------------------------- */
/*  Entries                                     */
/* -------------------------------------------- */

/**
 * @param {Playlist} container
 * @param {{path: string, name?: string, flags?: object}[]} specs
 * @returns {Promise<PlaylistSound[]>}
 */
export async function createEntries(container, specs) {
  if (!container || !specs.length || !canWrite("entry creation")) return [];
  return foundry.documents.PlaylistSound.implementation.createDocuments(specs.map(entrySpecWithFlags), { parent: container });
}

/**
 * @param {Playlist} container
 * @param {object[]} updates Each carries an _id.
 * @returns {Promise<PlaylistSound[]>}
 */
export async function updateEntries(container, updates) {
  if (!container || !updates.length || !canWrite("entry update")) return [];
  return foundry.documents.PlaylistSound.implementation.updateDocuments(updates, { parent: container });
}

/**
 * An entry IS the membership — there is nothing to un-flag, so this is a real delete and the
 * UI says so ("Remove from this playlist").
 * @param {Playlist} container
 * @param {string[]} ids
 * @returns {Promise<PlaylistSound[]>}
 */
export async function deleteEntries(container, ids) {
  if (!container || !ids.length || !canWrite("entry deletion")) return [];
  return foundry.documents.PlaylistSound.implementation.deleteDocuments(ids, { parent: container });
}

/**
 * Empty a container in one batch. Used on the queue, which must never accumulate.
 * @param {Playlist} container
 * @returns {Promise<PlaylistSound[]>}
 */
export async function clearContainer(container) {
  return deleteEntries(container, getEntries(container).map(s => s.id));
}

/* -------------------------------------------- */
/*  Macros                                      */
/* -------------------------------------------- */

// The two flags written below get no DataModel in flag-models.js, and that is deliberate: one is a
// bare boolean and the other is a path copied verbatim out of PlaylistSound#path, which the
// database validated as an audio FilePathField before we ever read it. There is no shape for a
// model to guard, and readThrough()'s "fall back to the defaults" recovery has nothing to recover
// to for a required path.

/**
 * The module's folder in the Macro sidebar. Created on the first drag of a pad onto the hotbar
 * rather than at bootstrap: a world where nobody ever does that should not grow an empty folder
 * in a sidebar this module otherwise never touches.
 * @returns {Promise<Folder|undefined>}
 */
export async function createMacroFolder() {
  if (!canWrite("macro folder creation")) return undefined;
  const [folder] = await foundry.documents.Folder.implementation.createDocuments([{
    name: FOLDER_NAMES.MACROS,
    type: "Macro",
    color: MACRO_FOLDER_COLOR,
    flags: { [MODULE_ID]: { [FLAGS.MACRO_FOLDER]: true } }
  }]);
  return folder;
}

/**
 * @param {{name: string, command: string, img: string, path: string, folder?: string|null}} spec
 * @returns {Promise<Macro|undefined>}
 */
export async function createMacro(spec) {
  if (!canWrite("macro creation")) return undefined;
  const [macro] = await foundry.documents.Macro.implementation.createDocuments([{
    name: spec.name,
    type: foundry.CONST.MACRO_TYPES.SCRIPT,
    img: spec.img,
    command: spec.command,
    folder: spec.folder ?? null,
    flags: { [MODULE_ID]: { [FLAGS.SOUND_PATH]: spec.path } }
  }]);
  return macro;
}
