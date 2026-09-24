/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { CONSOLIDATE_DIR_BY_CHANNEL, CONTAINER_KINDS, LIBRARY_DIR, MODULE_ID } from "../constants.js";
import { basenameOf, filePickerClass, isRemotePath, normalizePath, slugify, toFetchUrl } from "../helpers.js";
import { getContainers, getEntries } from "../data/repository.js";
import { updateEntries } from "../data/mutations.js";
import * as library from "./index.js";
import * as store from "./store.js";

// Copy every library file into audio-console/audio/<kind>/ under a kebab-case name, so the whole
// library becomes self-contained and tidily named. The most destructive thing in the module and
// the least reversible: there is no delete, move, rename or copy anywhere in Foundry's file API
// (confirmed live), so the originals stay on disk permanently and every copy this makes is
// permanent too. Hence the plan/preview/confirm sequence this file implements step for step.
//
// Nothing here renders. The UI owns the dialogs; this owns the arithmetic and the writes.

const REPORT_VERSION = 1;

/** How many size probes are in flight at once. HEAD is one round-trip per file. */
const SIZE_PROBE_CONCURRENCY = 10;

/** Why an entry was left where it is. Both are normal, neither is a failure. */
export const SKIP_REASONS = {
  ALREADY: "already",
  REMOTE: "remote"
};

/** @param {string} channel One of CHANNELS. @returns {string} */
function dirFor(channel) {
  return `${LIBRARY_DIR}/audio/${CONSOLIDATE_DIR_BY_CHANNEL[channel]}`;
}

/**
 * The kebab-case filename for a stored path. The extension is lowercased and preserved separately:
 * slugifying it along with the stem would turn "Tavern Brawl.OGG" into "tavern-brawl-ogg".
 *
 * Feed this a decoded basename — stored paths are percent-encoded and slugifying the raw form
 * turns "Car%20Crash%201.mp3" into "car-20crash-201". basenameOf() decodes.
 *
 * Underscores become hyphens before slugify() sees them: Foundry's String#slugify drops "_"
 * entirely rather than treating it as a separator, which would run "crit-winged_angel" together
 * into "crit-wingedangel".
 *
 * @param {string} path
 * @returns {string}
 */
function normalizedFilename(path) {
  const basename = basenameOf(path);
  const dot = basename.lastIndexOf(".");
  const stem = (dot > 0) ? basename.slice(0, dot) : basename;
  const extension = (dot > 0) ? basename.slice(dot + 1).toLowerCase() : "";
  // A name of only symbols must still produce something.
  const slug = slugify(stem.replace(/_+/g, "-")) || "track";
  return extension ? `${slug}.${extension}` : slug;
}

/**
 * Filenames already sitting in a target directory, lowercased. Seeding the collision resolver with
 * these is what stops a second run — or a run after a cancelled one — from silently overwriting a
 * file an earlier run put there under the same normalised name. `browse` throws when the directory
 * does not exist yet, which is simply the first-run case.
 * @param {string} dir
 * @returns {Promise<Set<string>>}
 */
async function existingFilenames(dir) {
  try {
    const result = await filePickerClass().browse("data", dir);
    return new Set((result.files ?? []).map(file => basenameOf(file).toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Content-Length for each path, so the preview can quote a total size before the GM commits. HEAD
 * rather than GET: the whole point is to avoid materialising the files twice. A path that does not
 * answer is left unmeasured rather than reported as an error — the copy is what decides whether a
 * file is really gone, and it records that as a failure with the reason attached.
 * @param {{path: string}[]} copies Mutated in place: each gains a `size` (number or null).
 * @returns {Promise<{bytes: number, unmeasured: number}>}
 */
async function probeSizes(copies) {
  let bytes = 0;
  let unmeasured = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < copies.length) {
      const copy = copies[cursor++];
      try {
        const res = await fetch(toFetchUrl(copy.path), { method: "HEAD" });
        // get() answers null when the header is absent, and Number(null) is 0 — a real-looking size
        // for a file nobody measured. Only a present header counts.
        const header = res.ok ? res.headers.get("content-length") : null;
        const length = header === null ? NaN : Number(header);
        if (Number.isFinite(length)) {
          copy.size = length;
          bytes += length;
          continue;
        }
      } catch { /* unreachable path — the copy will record it */ }
      copy.size = null;
      unmeasured++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(SIZE_PROBE_CONCURRENCY, copies.length) }, worker));
  return { bytes, unmeasured };
}

/* -------------------------------------------- */
/*  Plan                                        */
/* -------------------------------------------- */

/**
 * Steps 1–2 of the plan/preview/confirm sequence: collect what would move, resolve the collisions,
 * total the bytes. Touches nothing — the whole point is that the GM sees this before anything is
 * written.
 *
 * @returns {Promise<{copies: object[], skipped: object[], collisions: object[], bytes: number,
 *   unmeasured: number}>}
 */
export async function planConsolidation() {
  const copies = [];
  const skipped = [];

  for (const entry of library.getAllEntries()) {
    if (isRemotePath(entry.path)) {
      skipped.push({ path: entry.path, name: entry.name, reason: SKIP_REASONS.REMOTE });
      continue;
    }
    // Skipping what is already here is what makes re-running a no-op, and what lets a cancelled
    // run resume where it stopped: the copies it did make were repointed before it returned.
    if (entry.path.startsWith(`${LIBRARY_DIR}/`)) {
      skipped.push({ path: entry.path, name: entry.name, reason: SKIP_REASONS.ALREADY });
      continue;
    }
    // `kind` here is this file's own working name for "which subfolder" (dirFor below), which the
    // entry's channel decides.
    copies.push({ path: entry.path, name: entry.name, kind: entry.channel });
  }

  // Collisions are guaranteed — "Chuva Forte.ogg" and "chuva-forte.ogg" normalise identically — so
  // the order the suffixes are handed out in has to be stable rather than catalogue-insertion
  // order. Plain codepoint order on the normalised path: locale-independent, and the same on every
  // machine that runs this.
  copies.sort((a, b) => (a.path < b.path) ? -1 : ((a.path > b.path) ? 1 : 0));

  const taken = new Map();
  for (const kind of new Set(copies.map(copy => copy.kind))) {
    taken.set(kind, await existingFilenames(dirFor(kind)));
  }

  const collisions = [];
  for (const copy of copies) {
    const wanted = normalizedFilename(copy.path);
    const used = taken.get(copy.kind);
    const dot = wanted.lastIndexOf(".");
    const stem = (dot > 0) ? wanted.slice(0, dot) : wanted;
    const suffix = (dot > 0) ? wanted.slice(dot) : "";
    let filename = wanted;
    let counter = 1;
    while (used.has(filename.toLowerCase())) filename = `${stem}-${++counter}${suffix}`;
    used.add(filename.toLowerCase());
    copy.filename = filename;
    copy.newPath = `${dirFor(copy.kind)}/${filename}`;
    copy.collision = filename !== wanted;
    if (copy.collision) collisions.push({ path: copy.path, name: copy.name, wanted, filename });
  }

  const { bytes, unmeasured } = await probeSizes(copies);
  return { copies, skipped, collisions, bytes, unmeasured };
}

/* -------------------------------------------- */
/*  Run                                         */
/* -------------------------------------------- */

/**
 * Step 5: point both stores at the new locations. The catalogue is one in-memory pass plus one
 * save; the documents are batched per parent playlist, because a module-owned PlaylistSound
 * already sitting in a playlist would otherwise keep pointing at the original file.
 * @param {Map<string, string>} mapping Normalised old path -> new path.
 * @returns {Promise<{entries: number, sounds: number}>}
 */
async function repoint(mapping) {
  if (!mapping.size) return { entries: 0, sounds: 0 };
  const entries = library.repointEntries(mapping);
  await library.flushSave();

  let sounds = 0;
  for (const kind of Object.values(CONTAINER_KINDS)) {
    for (const container of getContainers(kind)) {
      const updates = [];
      for (const sound of getEntries(container)) {
        const to = mapping.get(normalizePath(sound.path));
        if (to) updates.push({ _id: sound.id, path: to });
      }
      if (!updates.length) continue;
      await updateEntries(container, updates);
      sounds += updates.length;
    }
  }
  return { entries, sounds };
}

/**
 * Steps 4–7: copy sequentially, repoint, write the report.
 *
 * Never Promise.all: each file is fully materialised in browser memory as a Blob, and a parallel
 * pass over a large library would exhaust it. One Blob is live at a time, by construction.
 *
 * A cancelled run still repoints everything it managed to copy — that is what makes the next run
 * resume rather than start over, since the planner skips whatever already lives here.
 *
 * @param {object} plan From planConsolidation().
 * @param {{onProgress?: (done: number, total: number, name: string) => void,
 *   shouldCancel?: () => boolean}} [options]
 * @returns {Promise<object>} The report, plus the path it was written to (null if that failed).
 */
export async function runConsolidation(plan, { onProgress, shouldCancel } = {}) {
  const copied = [];
  const failed = [];
  const ensured = new Set();
  const total = plan.copies.length;
  let cancelled = false;

  for (const copy of plan.copies) {
    if (shouldCancel?.()) {
      cancelled = true;
      break;
    }
    onProgress?.(copied.length + failed.length, total, copy.name);
    const dir = dirFor(copy.kind);
    try {
      if (!ensured.has(dir)) {
        await store.ensureDirectory(dir);
        ensured.add(dir);
      }
      // toFetchUrl, never encodeURI: stored paths are already percent-encoded, and encoding twice
      // turns %20 into %2520 — which would fail on exactly the badly-named files this exists for.
      const res = await fetch(toFetchUrl(copy.path));
      if (!res.ok) {
        failed.push({ path: copy.path, name: copy.name, reason: `HTTP ${res.status}` });
        continue;
      }
      const blob = await res.blob();
      await store.writeFile(dir, copy.filename, blob, { ensureDir: false });
      copied.push({ from: copy.path, to: copy.newPath, bytes: blob.size });
    } catch (err) {
      // writeFile throws when upload() resolves false — a run that reported success while copying
      // nothing would be the worst possible outcome for this feature.
      console.error(`${MODULE_ID} | failed to copy ${copy.path}`, err);
      failed.push({ path: copy.path, name: copy.name, reason: String(err?.message ?? err) });
    }
  }
  onProgress?.(copied.length + failed.length, total, "");

  const repointed = await repoint(new Map(copied.map(copy => [normalizePath(copy.from), copy.to])));

  const report = {
    version: REPORT_VERSION,
    ranAt: new Date().toISOString(),
    cancelled,
    planned: total,
    copied,
    failed,
    skipped: plan.skipped,
    collisions: plan.collisions,
    repointed
  };
  let reportPath = null;
  try {
    reportPath = await store.writeReport(report);
  } catch (err) {
    console.error(`${MODULE_ID} | could not write the consolidation report`, err);
  }
  return { ...report, reportPath };
}
