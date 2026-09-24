/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID, LIBRARY_DIR } from "../constants.js";
import { canWrite, filePickerClass } from "../helpers.js";

// The only file owning Data/audio-console/library.json. library/index.js is the only caller. Two
// write traps are load-bearing here and both are confirmed live: createDirectory() does not create
// intermediate levels, and upload() resolves false on failure instead of throwing. Both are
// handled below, once, so nothing else in the module has to remember them.

const LIBRARY_FILENAME = "library.json";
const README_FILENAME = "README.txt";
const REPORT_FILENAME = "consolidation-report.json";
// Short on purpose. A pending save cannot survive the page unloading — an upload started from
// beforeunload never completes (confirmed live: a tag changed and the page reloaded inside the
// window came back with the old tag) — so the window has to be smaller than the time it takes to
// reach F5, while still folding the two or three persists one dialog produces into one write.
const SAVE_DEBOUNCE_MS = 250;

const README_TEXT = `Audio Console — data folder

library.json holds your audio catalogue: file paths, names and tags.
Deleting this folder deletes your tags. The audio files themselves live
wherever you registered them from and are not affected.

Safe to back up by copying. Safe to carry to another Foundry installation.
`;

/** Directories this session has already created or confirmed. A round-trip each, so once is enough. */
const ensuredDirs = new Set();

/**
 * createDirectory() only ever creates one level, and throws EEXIST — confirmed message
 * "EEXIST: file already exists, mkdir '…'" — on every run after the first. Walk the path a
 * segment at a time so a fresh folder or a deeper one both work.
 *
 * Remembered per session: each call is a server round-trip (~0.6 s over loopback here), and
 * paying it on every catalogue save was most of what a save cost. writeFile() forgets the
 * directory again when an upload fails, so a folder deleted mid-session is recreated on the retry.
 *
 * Exported for consolidate.js, which ensures its two audio directories once per run instead of
 * once per file — see writeFile()'s `ensureDir` option.
 * @param {string} dir
 */
export async function ensureDirectory(dir) {
  if (ensuredDirs.has(dir)) return;
  let walked = "";
  for (const segment of dir.split("/").filter(Boolean)) {
    walked = walked ? `${walked}/${segment}` : segment;
    try {
      await filePickerClass().createDirectory("data", walked);
    } catch (err) {
      if (!/exist/i.test(String(err?.message ?? err))) throw err;
    }
  }
  ensuredDirs.add(dir);
}

/**
 * The module's single write path: everything this module puts on disk — the catalogue, README.txt,
 * the consolidation report, and every audio file consolidate.js copies — goes through this pair,
 * so the two upload traps stay handled in exactly one place.
 *
 * `ensureDir: false` is for a caller that has already ensured the directory and is about to write
 * many files into it. Every createDirectory call is a server round-trip (measured at ~0.6 s over
 * this installation's loopback), and three of them per copied file would dominate a consolidate
 * run. Nothing else should pass it: for a single write, re-ensuring is what keeps a GM who deleted
 * the folder mid-session from silently losing the next save.
 *
 * @param {string} dir
 * @param {string} filename
 * @param {Blob} blob
 * @param {{ensureDir?: boolean}} [options]
 * @returns {Promise<string>} The Foundry-relative path written.
 */
export async function writeFile(dir, filename, blob, { ensureDir = true } = {}) {
  if (ensureDir) await ensureDirectory(dir);
  const file = new File([blob], filename, { type: blob.type });
  // upload() resolves false on failure instead of throwing, and fires its own error toast even
  // with notify:false — that toast is how the missing-directory trap first announced itself.
  const upload = () => filePickerClass().upload("data", dir, file, {}, { notify: false });
  let result = await upload();
  // The likeliest failure is the directory having gone away since it was ensured; re-ensure once
  // and try again before giving up.
  if ((result?.status !== "success") && ensureDir && ensuredDirs.has(dir)) {
    ensuredDirs.delete(dir);
    await ensureDirectory(dir);
    result = await upload();
  }
  if (result?.status !== "success") {
    throw new Error(`${MODULE_ID} | failed to write ${dir}/${filename}`);
  }
  return result.path;
}

function writeJSON(dir, filename, data) {
  return writeFile(dir, filename, new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
}

function writeText(dir, filename, text) {
  return writeFile(dir, filename, new Blob([text], { type: "text/plain" }));
}

/**
 * Read one JSON file with the mandatory cache-buster. Without it the browser happily serves the
 * copy it cached before the last write. Distinguishes "absent" (a plain 404 — expected on a fresh
 * install) from "present but unparsable" from "unreachable" (fetch() itself threw — a network
 * failure, not a missing file) so callers can tell all three apart.
 * @param {string} filename
 * @returns {Promise<{ok: boolean, data?: object, error?: Error, unreachable?: boolean}>}
 */
async function readJSON(filename) {
  let res;
  try {
    res = await fetch(`${LIBRARY_DIR}/${filename}?t=${Date.now()}`);
  } catch (err) {
    return { ok: false, unreachable: true, error: err };
  }
  if (!res.ok) return { ok: false };
  try {
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: true, error: err };
  }
}

/**
 * Read the catalogue. A missing primary (first run, or the folder was deleted) returns null and
 * is treated as an empty catalogue by the caller, silently — that is the fresh-install path. An
 * unreachable data folder (fetch() itself failed, not a 404) is the one failure the GM is told
 * about: it looks exactly like a fresh install otherwise.
 * @returns {Promise<object|null>}
 */
export async function load() {
  const primary = await readJSON(LIBRARY_FILENAME);
  if (primary.unreachable) {
    console.error(`${MODULE_ID} | could not reach the data folder`, primary.error);
    ui.notifications.error(game.i18n.localize("AUDIO_CONSOLE.Library.Notify.Unreachable"));
    return null;
  }
  if (primary.ok && primary.data !== undefined) return primary.data;
  if (primary.ok && primary.error) {
    console.error(`${MODULE_ID} | library.json is unreadable; starting from an empty catalogue`, primary.error);
  }
  return null;
}

/**
 * The consolidation report, written next to the catalogue.
 * @param {object} report
 * @returns {Promise<string>} The Foundry-relative path written.
 */
export function writeReport(report) {
  return writeJSON(LIBRARY_DIR, REPORT_FILENAME, report);
}

let pendingData = null;
let saveTimer = null;
let saving = false;
let saveAgain = false;

async function performSave() {
  if (pendingData === null) return;
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  const data = pendingData;
  pendingData = null;
  try {
    await writeJSON(LIBRARY_DIR, LIBRARY_FILENAME, data);
  } catch (err) {
    console.error(`${MODULE_ID} | failed to save library.json`, err);
    ui.notifications.error(game.i18n.localize("AUDIO_CONSOLE.Library.Notify.SaveFailed"));
  } finally {
    saving = false;
  }
  if (saveAgain) {
    saveAgain = false;
    await performSave();
  }
}

/**
 * Schedule a debounced write of the whole catalogue document. Coalesces bursts — retagging
 * several rows in a row must not fire one upload per row.
 * @param {{version: number, updatedAt: string, entries: object[]}} data
 */
export function save(data) {
  if (!canWrite("library.json save")) return;
  pendingData = data;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void performSave();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Bypass the debounce and write whatever is pending right now. Use after a bulk operation and on
 * the beforeunload path below — a debounced save still pending when the browser unloads is a
 * lost edit.
 * @returns {Promise<void>}
 */
export async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await performSave();
}

window.addEventListener("beforeunload", () => {
  void flush();
});

/**
 * Write README.txt once, only when it is not already there — never overwrite, in case the GM
 * annotated it. A bare data folder at the Foundry root looks like leftovers and there is no way
 * to recover it if a GM tidying up deletes it.
 * @returns {Promise<void>}
 */
export async function ensureReadme() {
  if (!game.user.isGM) return;
  const res = await fetch(`${LIBRARY_DIR}/${README_FILENAME}?t=${Date.now()}`);
  if (res.ok) return;
  try {
    await writeText(LIBRARY_DIR, README_FILENAME, README_TEXT);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not write README.txt`, err);
  }
}
