/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID, SECTIONS, FOLDER_NAMES } from "../constants.js";
import { getEntries, getQueue, getSectionFolder } from "./repository.js";
import { clearContainer, createQueue, createSectionFolders } from "./mutations.js";

// The section folders, in creation order. The root is created first because the other three are
// its children and a batch cannot reference an id produced earlier in the same batch.
const CHILD_SECTIONS = [
  { section: SECTIONS.PLAYLISTS, name: FOLDER_NAMES.PLAYLISTS },
  { section: SECTIONS.SOUNDBOARDS, name: FOLDER_NAMES.SOUNDBOARDS },
  { section: SECTIONS.AMBIENCES, name: FOLDER_NAMES.AMBIENCES }
];

/**
 * Create only what is missing. Runs on every world load and must stay idempotent.
 *
 * It never repairs what already exists: a GM who renamed "Soundboards" or dragged it elsewhere
 * has done something legal, because the flag identifies the folder and the folder is cosmetic.
 *
 * The active-GM guard is what stops two connected GMs racing to create the same folders.
 *
 * @returns {Promise<{folders: string[], queue: boolean, cleared: number}|null>} What was created,
 *   or null when this client is not the active GM. The return value exists for verification.
 */
export async function bootstrap() {
  if (!game.user.isActiveGM) return null;

  const created = { folders: [], queue: false, cleared: 0 };

  let root = getSectionFolder(SECTIONS.ROOT);
  if (!root) {
    [root] = await createSectionFolders([{ section: SECTIONS.ROOT, name: FOLDER_NAMES.ROOT, parent: null }]);
    created.folders.push(SECTIONS.ROOT);
  }

  const missing = CHILD_SECTIONS.filter(s => !getSectionFolder(s.section));
  if (missing.length) {
    await createSectionFolders(missing.map(s => ({ ...s, parent: root?.id ?? null })));
    created.folders.push(...missing.map(s => s.section));
  }

  // One scratch queue, always empty at world load — it is where a library track becomes a
  // PlaylistSound for as long as it plays, and it must never accumulate.
  let queue = getQueue();
  if (!queue) {
    queue = await createQueue(root?.id ?? null);
    created.queue = true;
  } else {
    const leftovers = getEntries(queue).length;
    if (leftovers) {
      await clearContainer(queue);
      created.cleared = leftovers;
    }
  }

  if (created.folders.length || created.queue || created.cleared) {
    console.log(`${MODULE_ID} | bootstrap`, created);
  }
  return created;
}
