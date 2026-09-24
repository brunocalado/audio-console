/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { LIBRARY_CHANGED_HOOK, MIN_TAG_LENGTH, MODULE_ID } from "../constants.js";
import { normalizePath, basenameOf, filePickerClass, humanizeName, isRemotePath, normalizeTag, normalizeTags, toFetchUrl } from "../helpers.js";
import { LibraryEntry, buildLibraryEntry, validateLibraryEntry } from "../data/flag-models.js";
import * as store from "./store.js";

// The UI never touches library.json directly: this module owns the in-memory catalogue, keyed by
// normalizePath(), and is the only thing that calls store.js. No database round-trips — searching
// a few thousand rows in memory is instant, which is a direct benefit of the library not being
// documents.

const CATALOGUE_VERSION = 1;

// Audio extensions recognised by scanFolder().
//
// The leading dot is required and its absence fails silently: browse() matches this list against
// path.extname(), which yields ".mp3". Core builds its own list the same way — FilePicker's
// #getExtensions maps the keys of CONST.AUDIO_FILE_EXTENSIONS through `.${t}`. Measured live in
// v14.365 on a folder of seven mp3s: bare keys returned 0 files, dotted returned all 7.
const AUDIO_EXTENSIONS = [".mp3", ".ogg", ".wav", ".m4a", ".flac", ".opus", ".webm"];

/** @type {Map<string, {path: string, name: string, tags: string[], volume: number, missing: boolean, searchKey: string}>} */
let catalogue = new Map();
let loaded = false;

/**
 * The global tag vocabulary: every regular tag that exists in this library, whether or not any row
 * currently carries it, mapped to the *group* it belongs to.
 *
 * Stored rather than derived from the rows: derived, a tag would be a side effect of using it —
 * nothing could be created ahead of time, and the last row to drop a tag would delete it for good.
 * Tags are a vocabulary a GM curates. It stays a *superset* of what the rows use — every write path
 * folds its tags in through rememberTags() — so a hand-edited or imported library.json heals
 * itself on load instead of losing anything.
 *
 * Every tag is ordinary: no word is reserved, because an entry's channel is a field of its own
 * (constants.js CHANNELS) rather than a tag pretending to be one.
 *
 * The group is what turns the filter panel from a pile of words into facets. Tags sharing a group
 * are alternatives to each other — picking `fantasy` and `scifi` from `genre` asks for either —
 * while tags in different groups narrow against each other. A tag with no group is `""`, and the
 * rule stays uniform because an ungrouped tag behaves as a group of one: "any of these" over a
 * single member is just that member: a plain AND.
 * Groups are free text, coined by a content pack (api.js) or by the GM in the tag manager; nothing
 * anywhere holds a list of permitted ones.
 * @type {Map<string, string>} tag -> group name, "" when ungrouped.
 */
let tagGroups = new Map();

/**
 * Display names for folders, keyed by normalised folder path. A folder exists because rows live
 * under it — this is not a folder registry, it only says what to call one whose on-disk name is
 * a slug (`314-shuttle-crash`), and it is written by content packs alone (api.js). A folder with
 * no name here shows its path segment.
 * @type {Map<string, string>}
 */
let folderNames = new Map();

// What the pending notification covers. A library write is usually one row — a tag clicked, a
// channel switched — and saying *which* row is what lets the console redraw the Library alone
// instead of every section that might have been showing that path (console-normal.js). Accumulated
// across the debounce window rather than reported per write, because a tag rename is one
// notification about several hundred rows.
const pendingPaths = new Set();

// Set by a change too broad to enumerate — the catalogue replaced wholesale, every path repointed.
// Those redraw everything, which is the safe answer and a rare one.
let pendingAll = false;

// Whether the *vocabulary* moved, independently of any row. Creating a tag without applying it is
// exactly this case: no entry changed, but the filter panel gained a chip.
let pendingVocabulary = false;

const notify = foundry.utils.debounce(() => {
  const change = {
    paths: pendingAll ? null : new Set(pendingPaths),
    vocabulary: pendingVocabulary
  };
  pendingPaths.clear();
  pendingAll = false;
  pendingVocabulary = false;
  foundry.helpers.Hooks.callAll(LIBRARY_CHANGED_HOOK, change);
}, 100);

/**
 * Record what the next notification is about, then schedule it.
 * @param {{paths?: Iterable<string>, all?: boolean, vocabulary?: boolean}} [spec]
 *   `paths` are normalised catalogue keys. `all` means "cannot be enumerated". Omitting both is a
 *   vocabulary-only change.
 */
function notifyChange({ paths, all = false, vocabulary = false } = {}) {
  if (all) pendingAll = true;
  else for (const path of paths ?? []) pendingPaths.add(path);
  if (vocabulary) pendingVocabulary = true;
  notify();
}

/**
 * Attach the precomputed lowercase search key. Lowercasing a few thousand names and paths on
 * every keystroke is half of what makes a plain search feel slow, so it is done once, when the
 * row enters the catalogue. Runtime-only, like `missing` — never written to library.json.
 * @param {object} entry
 * @returns {object}
 */
function withSearchKey(entry) {
  return { ...entry, searchKey: `${entry.name}\n${entry.path}`.toLowerCase() };
}

/**
 * A stored row is exactly the LibraryEntry schema's own fields, taken by name.
 *
 * An allowlist, and specifically one the schema hands over rather than a list written here. Rows in
 * the catalogue carry runtime state alongside their stored fields — `missing`, `searchKey`,
 * `missingChecked` — and a list of those written by hand is one a new runtime field slips past into
 * library.json. Reading the field names off the model makes the write
 * path agree with the read path (validateLibraryEntry, which builds from the same schema) by
 * construction: a field added to the schema is stored without anything here changing, and a runtime
 * field added to a row cannot leak no matter what it is called.
 *
 * Resolved on each call rather than at module load: `schema` is a lazy static on DataModel and this
 * file is imported during `init`. Foundry caches the SchemaField after the first access, so this is
 * a property read — 3.4 ms for 1535 rows, against 77 ms for the obvious alternative of round-
 * tripping every row through `new LibraryEntry().toObject()`.
 * @param {object} entry
 * @returns {object}
 */
function toStoredRow(entry) {
  const stored = {};
  for (const key of Object.keys(LibraryEntry.schema.fields)) stored[key] = entry[key];
  return stored;
}

/**
 * The catalogue exactly as it goes to disk. Also what "Export a copy" downloads, so the exported
 * file and library.json are the same document by construction rather than by two serialisers
 * agreeing.
 * @returns {{version: number, updatedAt: string, entries: object[]}}
 */
export function toCatalogueDocument() {
  return {
    version: CATALOGUE_VERSION,
    updatedAt: new Date().toISOString(),
    // An object rather than an array because a tag now carries its group; sorted by key, so a diff
    // of two library.json files shows what actually changed rather than insertion order. A file
    // whose tags are missing entirely still loads — the rows reseed the vocabulary, ungrouped.
    tags: Object.fromEntries([...tagGroups].sort(([a], [b]) => a.localeCompare(b))),
    folders: Object.fromEntries([...folderNames].sort(([a], [b]) => a.localeCompare(b))),
    entries: [...catalogue.values()].map(toStoredRow)
  };
}

/**
 * @param {object|undefined} stored The `folders` key of a catalogue document.
 * @returns {Map<string, string>}
 */
function toFolderNames(stored) {
  const names = new Map();
  if (!stored || (typeof stored !== "object")) return names;
  for (const [rawPath, name] of Object.entries(stored)) {
    const path = normalizePath(rawPath);
    const label = typeof name === "string" ? name.trim() : "";
    if (path && label) names.set(path, label);
  }
  return names;
}

/**
 * Fold regular tags into the vocabulary. Called by every write that can introduce one, so a tag
 * applied to a row is a tag that exists globally from that moment on — which is what makes typing
 * a new tag in the edit dialog enough to have it offered on every other track.
 * @param {Iterable<string>} tags
 * @returns {number} How many were new.
 */
function rememberTags(tags) {
  let added = 0;
  for (const tag of tags ?? []) {
    if (!tag || tagGroups.has(tag)) continue;
    // Ungrouped: a tag learned from a row says nothing about which facet it belongs to, and
    // guessing one would be worse than the honest "" that behaves exactly as it always did.
    tagGroups.set(tag, "");
    added++;
  }
  return added;
}

/**
 * The vocabulary a catalogue document implies: what it stored, with its groups, plus anything its
 * rows use that it somehow did not list. The union is the self-healing half — a hand-edited
 * library.json, or one whose `tags` key is gone, still loads with every tag its rows mention.
 * @param {Record<string, string>|undefined} stored
 * @param {Map<string, object>} rows
 * @returns {Map<string, string>}
 */
function seedVocabulary(stored, rows) {
  tagGroups = new Map();
  if (stored && (typeof stored === "object") && !Array.isArray(stored)) {
    for (const [rawTag, rawGroup] of Object.entries(stored)) {
      const tag = normalizeTag(rawTag);
      if (tag) tagGroups.set(tag, normalizeTagGroup(rawGroup));
    }
  }
  for (const entry of rows.values()) rememberTags(entry.tags);
  return tagGroups;
}

/**
 * A group name, held to the same shape as a tag so the two cannot drift into different spellings
 * of the same word. Blank is the valid "no group" answer, which is why this never returns null.
 * @param {string} group
 * @returns {string}
 */
function normalizeTagGroup(group) {
  return typeof group === "string" ? normalizeTag(group) : "";
}

function persist() {
  store.save(toCatalogueDocument());
}

/* -------------------------------------------- */
/*  Load                                        */
/* -------------------------------------------- */

/**
 * Validate raw rows into a catalogue Map keyed by normalised path. Rows that fail LibraryEntry
 * validation are dropped and logged rather than breaking the whole catalogue — that rule holds
 * for an imported file just as much as for library.json itself, which is why both arrive here.
 * @param {object[]} rows
 * @returns {Map<string, object>}
 */
function toCatalogueMap(rows) {
  const next = new Map();
  for (const row of rows ?? []) {
    const entry = validateLibraryEntry(row);
    if (!entry) continue;
    const path = normalizePath(entry.path);
    // Re-normalising here (not just on dialog submit) catches tags that never went through
    // normalizeTag at all — a hand-edited or imported library.json — so a too-long tag heals
    // itself the next time the catalogue loads.
    next.set(path, withSearchKey({ ...entry, path, missing: false, tags: normalizeTags(entry.tags) }));
  }
  return next;
}

/**
 * Load the catalogue once, on `ready`. Also writes README.txt on first run.
 * @returns {Promise<number>} Entries loaded.
 */
export async function loadLibrary() {
  const raw = await store.load();
  catalogue = toCatalogueMap(raw?.entries);
  seedVocabulary(raw?.tags, catalogue);
  folderNames = toFolderNames(raw?.folders);
  loaded = true;
  await store.ensureReadme();
  notifyChange({ all: true, vocabulary: true });
  return catalogue.size;
}

/** @returns {boolean} */
export function isLoaded() {
  return loaded;
}

/* -------------------------------------------- */
/*  Reads                                       */
/* -------------------------------------------- */

/**
 * @param {string} path
 * @returns {object|null}
 */
export function getEntry(path) {
  return catalogue.get(normalizePath(path)) ?? null;
}

/** @returns {object[]} */
export function getAllEntries() {
  return [...catalogue.values()];
}

/**
 * The global tag vocabulary with how many rows currently carry each one. A count of 0 is a real,
 * expected answer now — a tag created for later use, or one whose last row was retagged — and is
 * exactly what the tag manager needs in order to show a tag that would otherwise be invisible.
 *
 * Counts are still taken from the rows rather than maintained alongside them: two numbers that
 * can disagree is a bug waiting to happen, and a few thousand rows is nothing to walk.
 * @returns {Map<string, {count: number, group: string}>} For every tag in the vocabulary.
 */
export function getTagVocabulary() {
  const info = new Map();
  for (const [tag, group] of tagGroups) info.set(tag, { count: 0, group });
  for (const entry of catalogue.values()) {
    for (const tag of entry.tags) {
      const row = info.get(tag) ?? { count: 0, group: "" };
      row.count++;
      info.set(tag, row);
    }
  }
  return info;
}

/** @returns {boolean} Whether the vocabulary already holds this exact (normalised) tag. */
export function hasTag(tag) {
  return tagGroups.has(normalizeTag(tag));
}

/**
 * Bucket selected tags by their group, so a query can be evaluated one facet at a time.
 * @param {string[]|undefined} tags
 * @returns {Map<string, string[]>} group -> the selected tags in it. Ungrouped tags land in "".
 */
function groupSelection(tags) {
  const byGroup = new Map();
  for (const tag of tags ?? []) {
    const group = tagGroups.get(tag) ?? "";
    const bucket = byGroup.get(group);
    if (bucket) bucket.push(tag);
    else byGroup.set(group, [tag]);
  }
  return byGroup;
}

/**
 * Does this row satisfy a grouped tag selection? OR within a group, AND between groups — the
 * faceted rule. The "" bucket is ANDed member by member, which is the same rule seen from the
 * other side: an ungrouped tag is a group of one, and "any of these" over one member is that
 * member.
 * @param {object} entry
 * @param {Map<string, string[]>} selection
 * @returns {boolean}
 */
function matchesSelection(entry, selection) {
  for (const [group, tags] of selection) {
    if (group === "") {
      if (!tags.every(tag => entry.tags.includes(tag))) return false;
    } else if (!tags.some(tag => entry.tags.includes(tag))) return false;
  }
  return true;
}

/**
 * In-memory filter over the catalogue. Two join rules, deliberately, and they are now the same
 * rule: `channels` is a facet — every entry has exactly one channel, so ANDing them would match
 * zero rows the moment both boxes are checked — and `tags` is a set of facets, one per group.
 * Within a facet it is OR (checking both channels, or both of `fantasy` and `scifi`, widens);
 * between facets it is AND. For `channels`, `undefined` skips the facet entirely while `[]` (both
 * unchecked) matches nothing, which is a different answer.
 *
 * Grouping is what makes "either of these" expressible: clicking `fantasy` then `scifi` asks for
 * either, and an unconditional AND would answer with only the rows that are both.
 *
 * `text` matches name, path, or any one tag — one field for both, since typing a tag's name is
 * just as valid a way to find it as opening the tag panel and clicking it. See
 * .claude/rules/ui-patterns.md, "One search field, not two".
 * @param {{text?: string, tags?: string[], channels?: string[]}} [query]
 * @returns {object[]}
 */
export function search({ text, tags, channels } = {}) {
  const needle = text?.trim().toLowerCase();
  const matchesTags = tagMatcher(tags);
  return [...catalogue.values()].filter(entry => {
    if (channels && !channels.includes(entry.channel)) return false;
    if (!matchesTags(entry)) return false;
    if (needle && !entry.searchKey.includes(needle) && !entry.tags.some(tag => tag.includes(needle))) return false;
    return true;
  });
}

/**
 * A reusable predicate for one tag selection, so every list that filters by tag applies the same
 * join rule. The library table calls it through search(); the "Add from Library" picker filters
 * its own candidate pool with it rather than a copy of the rule that could drift.
 * @param {string[]|Iterable<string>} [tags]
 * @returns {(entry: object) => boolean}
 */
export function tagMatcher(tags = []) {
  const selection = groupSelection([...tags]);
  if (!selection.size) return () => true;
  return entry => matchesSelection(entry, selection);
}

/**
 * The model both tag panels draw: one block per group, each chip knowing whether it is selected
 * and whether picking it would empty the list.
 *
 * A dead chip is worth the pass: with one tag selected nothing is ever dead, but at two the median
 * across the tabletop-audio vocabulary is 24 of 49 chips, so from the second click on, half the
 * panel is otherwise a lie. It is answered by asking the real question — would the filter still
 * match a row? — rather than by a separate co-occurrence rule, so the chips and the table cannot
 * disagree. The pool is filtered by everything *except* tags once by the caller, and each candidate
 * is then tested against it with short-circuiting; a live tag usually settles on the first row.
 *
 * Group order is alphabetical with the ungrouped block last, since "everything that is not a facet"
 * is a remainder and reads as one.
 * @param {object[]} pool Rows matching the rest of the query, tags aside.
 * @param {Iterable<string>} [selected] Currently selected tags.
 * @param {{vocabulary?: Set<string>|null}} [options] `vocabulary` limits the chips to these tags —
 *   what the picker passes, because a chip for a tag no candidate carries can only ever filter its
 *   window down to nothing.
 * @returns {{group: string, tags: {tag: string, active: boolean, dead: boolean}[]}[]}
 */
export function tagFacets(pool, selected = [], { vocabulary = null } = {}) {
  const chosen = new Set(selected);
  const selection = groupSelection([...chosen]);
  const groups = new Map();
  for (const [tag, group] of tagGroups) {
    if (vocabulary && !vocabulary.has(tag) && !chosen.has(tag)) continue;
    let dead = false;
    // An already-selected chip is never dead: clicking it clears it.
    if (!chosen.has(tag)) {
      const hypothetical = new Map(selection);
      hypothetical.set(group, [...(selection.get(group) ?? []), tag]);
      dead = !pool.some(entry => matchesSelection(entry, hypothetical));
    }
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ tag, active: chosen.has(tag), dead });
  }
  for (const chips of groups.values()) chips.sort((a, b) => a.tag.localeCompare(b.tag));
  const blocks = [...groups.entries()]
    .filter(([group]) => group !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, tags]) => ({ group, tags }));
  const ungrouped = groups.get("");
  if (ungrouped?.length) blocks.push({ group: "", tags: ungrouped });
  return blocks;
}

/**
 * Verify whether a row's file still exists at its saved path, HEAD-probed once per session and
 * cached on the row itself. Meant to be called for the rows a caller has actually put in front of
 * a GM — the virtualised library table calls it only for rows the scroll window has painted —
 * never for the whole catalogue at once: a library of a few thousand files must not mean a few
 * thousand requests every time the console opens.
 *
 * A remote URL is never probed: fetching a cross-origin path fails CORS from the client
 * regardless of whether the file is actually there, so a failed HEAD would tell a lie.
 * @param {object} entry
 * @returns {Promise<boolean>} Whether the row is now considered missing.
 */
export async function checkMissing(entry) {
  if (entry.missingChecked || isRemotePath(entry.path)) return entry.missing;
  entry.missingChecked = true;
  try {
    const res = await fetch(toFetchUrl(entry.path), { method: "HEAD" });
    entry.missing = !res.ok;
  } catch {
    entry.missing = true;
  }
  return entry.missing;
}

/* -------------------------------------------- */
/*  Writes — GM only, store.js enforces it       */
/* -------------------------------------------- */

/**
 * Add new rows. Paths already in the catalogue are skipped; a caller that wants to retag an
 * existing row uses setTags()/updateEntry(), not this. Registering a file only records its
 * path — nothing is copied or moved.
 * @param {{path: string, name?: string, channel?: string, tags?: string[], volume?: number}[]}
 *   specs An omitted `channel` takes LibraryEntry's own initial; a value the schema does not know
 *   is refused there rather than stored.
 * @returns {object[]} The rows actually added.
 */
export function addEntries(specs) {
  const added = [];
  for (const spec of specs) {
    const path = normalizePath(spec.path);
    if (!path || catalogue.has(path)) continue;
    const entry = buildLibraryEntry({
      path,
      name: spec.name?.trim() || humanizeName(basenameOf(path)),
      channel: spec.channel,
      tags: normalizeTags(spec.tags ?? []),
      volume: spec.volume ?? 0.8
    });
    catalogue.set(path, withSearchKey({ ...entry, missing: false }));
    rememberTags(entry.tags);
    added.push(entry);
  }
  if (added.length) {
    persist();
    // A path that had no catalogue row until now flips `hasLibraryEntry` on any container showing
    // it, so the paths matter here as much as they do on a removal.
    notifyChange({ paths: added.map(entry => entry.path), vocabulary: true });
  }
  return added;
}

/**
 * Remove rows from the catalogue only — the file on disk is never touched.
 * @param {string[]} paths
 * @returns {number} Rows actually removed.
 */
export function removeEntries(paths) {
  const removed = [];
  for (const path of paths) {
    const key = normalizePath(path);
    if (catalogue.delete(key)) removed.push(key);
  }
  if (removed.length) {
    persist();
    notifyChange({ paths: removed });
  }
  return removed.length;
}

/**
 * @param {string} path A folder path as buildFolderTree walks it.
 * @returns {string|null} The display name a pack gave it, or null for "use the path segment".
 */
export function getFolderName(path) {
  return folderNames.get(path) ?? null;
}

/**
 * Name folders. A path that maps to nothing usable (blank) is skipped; an unchanged name is not a
 * write. One persist and one notification for the whole map, since a pack names hundreds at once.
 * @param {Record<string, string>} names Folder path → display name.
 * @param {{overwrite?: boolean}} [options] `false` leaves a folder that already has a name alone —
 *   the add-only rule a pack follows on every load; a sync overwrites.
 * @returns {number} Folders whose name changed.
 */
export function setFolderNames(names, { overwrite = true } = {}) {
  let changed = 0;
  for (const [rawPath, name] of Object.entries(names ?? {})) {
    const path = normalizePath(rawPath);
    const label = typeof name === "string" ? name.trim() : "";
    if (!path || !label) continue;
    if (!overwrite && folderNames.has(path)) continue;
    if (folderNames.get(path) === label) continue;
    folderNames.set(path, label);
    changed++;
  }
  if (changed) {
    persist();
    // A folder header is not a row, so no path names it: the tree is rebuilt whole.
    notifyChange({ all: true });
  }
  return changed;
}

/**
 * Assign tags to groups. A tag that is not in the vocabulary yet is coined by this call, because a
 * pack declaring `{ fantasy: "genre" }` is a pack saying that tag exists — it would otherwise have
 * to register a row carrying it first, in an order nothing guarantees.
 *
 * One persist and one notification for the whole map, since a pack groups dozens at once.
 * @param {Record<string, string>} groups Tag -> group name. A blank group clears one.
 * @param {{overwrite?: boolean}} [options] `false` leaves a tag that already has a non-blank group
 *   alone — the add-only rule a pack follows on every load; a sync overwrites.
 * @returns {number} Tags whose group changed.
 */
export function setTagGroups(groups, { overwrite = true } = {}) {
  let changed = 0;
  for (const [rawTag, rawGroup] of Object.entries(groups ?? {})) {
    const tag = normalizeTag(rawTag);
    if (!tag) continue;
    const group = normalizeTagGroup(rawGroup);
    const current = tagGroups.get(tag);
    if (!overwrite && current) continue;
    if (current === group) continue;
    tagGroups.set(tag, group);
    changed++;
  }
  if (changed) {
    persist();
    // No row changed — regrouping moves chips between blocks in the filter panel and nothing else.
    notifyChange({ vocabulary: true });
  }
  return changed;
}

/**
 * Replace an entry's whole tags array. Still routed through `buildLibraryEntry` rather than
 * assigned, so the row that lands in the catalogue is a schema-validated one.
 * @param {string} path
 * @param {string[]} tags
 * @returns {boolean} Whether the row was updated.
 */
export function setTags(path, tags) {
  const entry = getEntry(path);
  if (!entry) return false;
  let built;
  try {
    built = buildLibraryEntry({ ...entry, tags: normalizeTags(tags) });
  } catch (err) {
    console.error(`${MODULE_ID} | refused to save tags for ${path}`, err);
    return false;
  }
  Object.assign(entry, built);
  // A tag typed into the edit dialog becomes part of the vocabulary here, which is the whole
  // mechanism behind "tags are global": one row gains it, every row is offered it from then on.
  rememberTags(built.tags);
  persist();
  notifyChange({ paths: [entry.path], vocabulary: true });
  return true;
}

/**
 * Move an entry to another mixer channel. A value outside CHANNELS is refused by the schema and
 * the row is left alone — routing is not something to half-write.
 * @param {string} path
 * @param {string} channel
 * @returns {boolean} Whether the row was updated.
 */
export function setChannel(path, channel) {
  const entry = getEntry(path);
  if (!entry) return false;
  let built;
  try {
    built = buildLibraryEntry({ ...entry, channel });
  } catch (err) {
    console.error(`${MODULE_ID} | refused to set channel "${channel}" for ${path}`, err);
    return false;
  }
  Object.assign(entry, built);
  persist();
  notifyChange({ paths: [entry.path] });
  return true;
}

/**
 * Change a row's own fields. Tags are deliberately not among them — they are the vocabulary's
 * business, so they go through setTags() even when the same dialog collected both.
 * @param {string} path
 * @param {{name?: string, channel?: string, volume?: number}} changes
 * @returns {boolean} Whether the row was updated.
 */
export function updateEntry(path, changes) {
  const key = normalizePath(path);
  const existing = catalogue.get(key);
  if (!existing) return false;
  let built;
  try {
    built = buildLibraryEntry({ ...existing, ...changes, path: key, tags: existing.tags });
  } catch (err) {
    // Same contract as setChannel() above: a value the schema refuses leaves the row exactly as it
    // was rather than half-written.
    console.error(`${MODULE_ID} | refused to update ${path}`, err);
    return false;
  }
  catalogue.set(key, withSearchKey({ ...built, missing: existing.missing }));
  persist();
  notifyChange({ paths: [key] });
  return true;
}

/**
 * Point one row at a different file, keeping its name, tags and volume.
 *
 * A rekey rather than a field write: the path IS the catalogue's key, so the row leaves one slot
 * and lands in another. Only the catalogue moves. A PlaylistSound created from this row earlier
 * keeps the path it was made with, the same way removeEntries() leaves containers
 * alone — consolidate.js is the one place both halves move together, because there the files
 * themselves moved.
 * @param {string} from The row's current path.
 * @param {string} to Where it should point instead.
 * @returns {"moved"|"same"|"invalid"|"missing"|"taken"} What happened, so the caller can say which.
 */
export function moveEntry(from, to) {
  const key = normalizePath(from);
  const target = normalizePath(to);
  if (!target) return "invalid";
  const existing = catalogue.get(key);
  if (!existing) return "missing";
  if (target === key) return "same";
  // Two rows for one file would be two names and two tag sets for the same audio, and nothing on
  // screen would say which one a container was built from.
  if (catalogue.has(target)) return "taken";

  let built;
  try {
    built = buildLibraryEntry({ ...existing, path: target });
  } catch (err) {
    console.error(`${MODULE_ID} | refused to repoint ${key} to ${target}`, err);
    return "invalid";
  }
  catalogue.delete(key);
  // `missing` is deliberately not carried across: this is a different file, and whether it is
  // there is unknown until the row is painted and checked again.
  catalogue.set(target, withSearchKey({ ...built, missing: false }));
  persist();
  // Both paths go stale at once — the old one no longer resolves, the new one did not exist here
  // a moment ago.
  notifyChange({ paths: [key, target] });
  return "moved";
}

/* -------------------------------------------- */
/*  The tag vocabulary — add, rename, delete     */
/* -------------------------------------------- */

// Tags are global: these three operate on the vocabulary and on every row that mentions the tag,
// in one pass and one save. Nothing is protected from them — the channel is a field, not a tag,
// so there is no word here that a rename or a delete could break.

/**
 * Add a tag to the vocabulary without applying it to anything.
 * @param {string} tag Raw input; normalised here, so the caller need not.
 * @param {string} [group] The facet it belongs to. Omitted means ungrouped, which is what a tag
 *   coined in passing should be — grouping is a deliberate act in the tag manager.
 * @returns {{tag: string, created: boolean}|null} Null when the input normalises to nothing or to
 *   something shorter than MIN_TAG_LENGTH. `created: false` means it was already in the
 *   vocabulary — not an error, just nothing to do.
 */
export function createTag(tag, group = "") {
  const normalized = normalizeTag(tag);
  if (!normalized || (normalized.length < MIN_TAG_LENGTH)) return null;
  if (tagGroups.has(normalized)) return { tag: normalized, created: false };
  tagGroups.set(normalized, normalizeTagGroup(group));
  persist();
  // No row changed — this is the vocabulary-only case the flag exists for.
  notifyChange({ vocabulary: true });
  return { tag: normalized, created: true };
}

/**
 * Rename a tag everywhere at once: in the vocabulary and on every row carrying it.
 *
 * Renaming onto a tag that already exists is a merge, not a conflict — a row that had both ends up
 * with one, because normalizeTags() drops the duplicate. That is the useful behaviour for fixing
 * "ambient" and "ambience" having grown up side by side.
 * @param {string} from
 * @param {string} to Raw input; normalised here.
 * @returns {{from: string, to: string, entries: number, merged: boolean}|null} Null when `from` is
 *   not in the vocabulary, or `to` normalises to nothing.
 */
export function renameTag(from, to) {
  const source = normalizeTag(from);
  const target = normalizeTag(to);
  if (!source || !target || !tagGroups.has(source)) return null;
  // The floor applies to the new name only. `source` may legitimately be a short tag from an
  // imported or hand-edited catalogue — renaming it to something usable is how one gets cleaned up.
  if (target.length < MIN_TAG_LENGTH) return null;
  if (source === target) return { from: source, to: target, entries: 0, merged: false };

  const merged = tagGroups.has(target);
  // A merge keeps the surviving tag's own group: the target already sits in a facet, and renaming
  // onto it is a request to become that tag, group and all. Otherwise the group travels with the
  // name, because renaming `ambient` to `ambience` must not silently drop it out of its facet.
  const group = merged ? tagGroups.get(target) : tagGroups.get(source);
  const touched = [];
  for (const entry of catalogue.values()) {
    if (!entry.tags.includes(source)) continue;
    entry.tags = normalizeTags(entry.tags.map(tag => (tag === source ? target : tag)));
    touched.push(entry.path);
  }
  tagGroups.delete(source);
  tagGroups.set(target, group);
  persist();
  notifyChange({ paths: touched, vocabulary: true });
  return { from: source, to: target, entries: touched.length, merged };
}

/**
 * Remove a tag from the vocabulary and strip it from every row.
 * @param {string} tag
 * @returns {{tag: string, entries: number}|null} Null when it is not in the vocabulary.
 */
export function deleteTag(tag) {
  const normalized = normalizeTag(tag);
  if (!normalized || !tagGroups.has(normalized)) return null;
  const touched = [];
  for (const entry of catalogue.values()) {
    if (!entry.tags.includes(normalized)) continue;
    entry.tags = entry.tags.filter(t => t !== normalized);
    touched.push(entry.path);
  }
  tagGroups.delete(normalized);
  persist();
  notifyChange({ paths: touched, vocabulary: true });
  return { tag: normalized, entries: touched.length };
}

/**
 * Point rows at their new location after consolidate.js copied the files. One in-memory pass and
 * one save; the PlaylistSound half of the repoint is consolidate's own, because documents are
 * not this module's to write.
 * @param {Map<string, string>} mapping Normalised old path -> new path.
 * @returns {number} Rows repointed.
 */
export function repointEntries(mapping) {
  let changed = 0;
  const next = new Map();
  for (const [path, entry] of catalogue) {
    const to = mapping.get(path);
    if (!to) {
      next.set(path, entry);
      continue;
    }
    const newPath = normalizePath(to);
    next.set(newPath, withSearchKey({ ...entry, path: newPath }));
    changed++;
  }
  catalogue = next;
  if (changed) {
    persist();
    // Paths change identity here, so both the old and the new ones are stale everywhere at once.
    notifyChange({ all: true });
  }
  return changed;
}

/**
 * Force any pending debounced save to write immediately. Use after a bulk add (e.g. a folder
 * scan) and before the browser unloads.
 * @returns {Promise<void>}
 */
export function flushSave() {
  return store.flush();
}

/* -------------------------------------------- */
/*  Maintenance — recovery and moving installs   */
/* -------------------------------------------- */

// Normal operation needs none of these: the file IS the library. They exist for carrying a
// catalogue between installations and for getting out of trouble.

/**
 * Download the current catalogue through the browser, outside the data folder entirely. This is
 * the only backup there is: nothing else in the module copies library.json, and the data folder
 * it lives in is not part of a world backup.
 */
export function exportCopy() {
  foundry.utils.saveDataToFile(JSON.stringify(toCatalogueDocument(), null, 2), "application/json", "library.json");
}

/**
 * Validated rows out of a raw catalogue document, without touching the live catalogue — so an
 * import can be counted and confirmed before it is applied.
 * @param {object} data
 * @returns {object[]|null} Null when this is not a catalogue document at all.
 */
export function parseCatalogue(data) {
  if (!Array.isArray(data?.entries)) return null;
  // The same schema-driven strip toCatalogueDocument uses. These rows go to mergeEntries and
  // replaceAll, which put them straight into the catalogue, so "a row" has to mean the same shape
  // here as it does on the way to disk.
  return [...toCatalogueMap(data.entries).values()].map(toStoredRow);
}

/**
 * The catalogue becomes exactly these rows. Destructive by design — the caller confirms first.
 * @param {object[]} rows
 * @returns {number} Rows now in the catalogue.
 */
export function replaceAll(rows) {
  catalogue = toCatalogueMap(rows);
  // Same promise for folder names: the file has none in its rows, so none survive. A pack sets
  // its own again on the next load.
  folderNames = new Map();
  // The vocabulary is replaced along with the rows, not merged into them — "the catalogue becomes
  // the file exactly. Everything not in it is dropped, tags included" is what Replace already
  // promises, and a vocabulary that survived it would be the one thing that didn't.
  seedVocabulary(null, catalogue);
  persist();
  notifyChange({ all: true, vocabulary: true });
  return catalogue.size;
}

/**
 * Merge rows in, keyed by normalised path: new paths are added, an existing row keeps its name,
 * channel and volume, and its tags become the union of both. The incoming row's channel is not
 * applied to a path that is already here — an import adds vocabulary, it does not re-route what
 * this world already plays.
 *
 * Nothing here checks whether a file exists. A path absent on this machine may be present on the
 * next one, and dropping it would quietly destroy the tags that made the import worth doing.
 * @param {object[]} rows
 * @returns {{added: number, merged: number}}
 */
export function mergeEntries(rows) {
  let added = 0;
  let merged = 0;
  for (const row of rows ?? []) {
    const entry = validateLibraryEntry(row);
    if (!entry) continue;
    const path = normalizePath(entry.path);
    const existing = catalogue.get(path);
    if (!existing) {
      catalogue.set(path, withSearchKey({ ...entry, path, missing: false }));
      rememberTags(entry.tags);
      added++;
      continue;
    }
    existing.tags = normalizeTags([...existing.tags, ...entry.tags]);
    rememberTags(entry.tags);
    merged++;
  }
  if (added || merged) {
    persist();
    notifyChange({ all: true, vocabulary: true });
  }
  return { added, merged };
}

/* -------------------------------------------- */
/*  Adding files — FilePicker only, no upload flow of our own                    */
/* -------------------------------------------- */

/**
 * Open the native picker and wait for an answer. The picker's own contract is callback-only —
 * closing it without choosing calls nothing — so the close event is what settles the promise
 * with null; the callback fires before the picker closes itself, so a pick always wins.
 * @param {string} type A FilePicker type: "audio" or "folder".
 * @returns {Promise<string|null>} The chosen path, normalized, or null when dismissed.
 */
function pick(type) {
  return new Promise(resolve => {
    let chosen = null;
    const fp = new (filePickerClass())({
      type,
      callback: path => { chosen = normalizePath(path); }
    });
    fp.addEventListener("close", () => resolve(chosen), { once: true });
    fp.render(true);
  });
}

/**
 * The GM chooses one existing audio file already on the server. Uploading a NEW file is the
 * picker's own upload control; this module never builds a competing flow.
 * @returns {Promise<string|null>} The chosen path, normalized, or null when dismissed.
 */
export function pickFile() {
  return pick("audio");
}

/**
 * The GM chooses a directory to scan.
 * @returns {Promise<string|null>} The chosen directory, normalized, or null when dismissed.
 */
export function pickFolder() {
  return pick("folder");
}

/**
 * Browse a data-source folder for audio files not yet in the catalogue.
 * @param {string} dir Foundry-relative directory.
 * @param {{recurse?: boolean}} [options]
 * @returns {Promise<{path: string, name: string}[]>} Candidates, decoded and pre-filtered
 *   against the catalogue.
 */
export async function scanFolder(dir, { recurse = false } = {}) {
  const found = [];
  const queue = [dir];
  while (queue.length) {
    const target = queue.shift();
    const result = await filePickerClass().browse("data", target, { extensions: AUDIO_EXTENSIONS });
    for (const file of result.files ?? []) {
      const path = normalizePath(file);
      if (!catalogue.has(path)) found.push({ path, name: humanizeName(basenameOf(path)) });
    }
    if (recurse) queue.push(...(result.dirs ?? []));
  }
  return found;
}
