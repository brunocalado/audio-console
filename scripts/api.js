/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID, CHANNELS, CONTAINER_KINDS, SECTIONS } from "./constants.js";
import { normalizePath, normalizeTag, sanitizeUserTags } from "./helpers.js";
import { createContainers, createEntries, updateContainers, updateEntries } from "./data/mutations.js";
import { getContainers, getEntries, getSectionFolder } from "./data/repository.js";
import { buildContainerFlags, buildEntryFlags, readContainerFlags, readEntryFlags } from "./data/flag-models.js";
import { soundSpecFor } from "./audio/playback.js";
import * as library from "./library/index.js";

// The macro- and module-facing surface, documented in docs/API.md. A setup API, not an editing
// one: a content module registers what it ships, and this builds it — library rows with tags,
// containers in their section folders, every sound configured. Nothing here rewrites a thing
// that already exists, because a pack's registration runs on every world load and must never
// undo what the GM changed in the console since. The one exception is syncPack(), which the GM
// runs by hand from the Library maintenance settings app, and which overwrites only what a pack
// built and only the fields its spec defines.
//
// Validation at the boundary, then delegation: every write below goes through mutations.js and
// library/index.js exactly as the console's own does. Bad input throws — a module author gets a
// stack trace naming the argument, where a silent `[]` would tell them nothing.

const SECTION_FOR_KIND = {
  [CONTAINER_KINDS.PLAYLIST]: SECTIONS.PLAYLISTS,
  [CONTAINER_KINDS.SOUNDBOARD]: SECTIONS.SOUNDBOARDS,
  [CONTAINER_KINDS.AMBIENCE]: SECTIONS.AMBIENCES
};

/** @type {Map<string, {id: string, name: string, containers: object[]}>} */
const packs = new Map();

/* -------------------------------------------- */
/*  Guards and validators                       */
/* -------------------------------------------- */

function fail(message) {
  throw new Error(`${MODULE_ID} | ${message}`);
}

/**
 * Both checks matter. The global exists from `init`, but loadLibrary() runs in `ready` for the GM
 * alone (main.js): a caller writing before that writes into a catalogue loadLibrary() then
 * replaces.
 */
function assertWritable() {
  if (!game.user?.isGM) fail("the API is GM-only");
  if (!library.isLoaded()) fail('library not loaded yet — call after the "ready" hook');
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} must be one of ${allowed.map(v => `"${v}"`).join(", ")}, got ${JSON.stringify(value)}`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string, got ${JSON.stringify(value)}`);
  return value.trim();
}

function optional(value, check, label) {
  return value === undefined ? undefined : check(value, label);
}

function boolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be a boolean, got ${JSON.stringify(value)}`);
  return value;
}

function volume(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || (value < 0) || (value > 1)) fail(`${label} must be a number from 0 to 1, got ${JSON.stringify(value)}`);
  return value;
}

function color(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) fail(`${label} must be "#rrggbb" or null, got ${JSON.stringify(value)}`);
  return value.toLowerCase();
}

// The console's own rule for the fade field: a positive number of milliseconds, else null.
function fade(value, label) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || (value < 0)) fail(`${label} must be a number of milliseconds or null, got ${JSON.stringify(value)}`);
  return value > 0 ? Math.round(value) : null;
}

// sanitizeUserTags, not normalizeTags: a pack's tags land in the GM's global vocabulary and are
// offered on every row from then on. MIN_TAG_LENGTH exists to keep junk out of exactly that.
function tags(value, label) {
  if (!Array.isArray(value) || value.some(t => typeof t !== "string")) fail(`${label} must be an array of strings`);
  return sanitizeUserTags(value);
}

function random(value, label) {
  if (typeof value !== "object" || value === null) fail(`${label} must be an object {enabled, interval?, variance?, onStart?}`);
  const out = { enabled: boolean(value.enabled, `${label}.enabled`) };
  if (value.onStart !== undefined) out.onStart = boolean(value.onStart, `${label}.onStart`);
  for (const key of ["interval", "variance"]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) fail(`${label}.${key} must be a number`);
    out[key] = value[key];
  }
  return out;
}

/**
 * One sound of a spec, with the container-level defaults folded in. Returned with its path
 * normalised, because that is the key everything downstream compares on.
 */
function validateSound(sound, index, defaults) {
  const label = `sounds[${index}]`;
  if (typeof sound !== "object" || sound === null) fail(`${label} must be an object`);
  const path = normalizePath(nonEmptyString(sound.path, `${label}.path`));
  if (!path) fail(`${label}.path normalises to nothing`);
  return {
    path,
    name: optional(sound.name, nonEmptyString, `${label}.name`),
    channel: sound.channel === undefined ? defaults.channel : oneOf(sound.channel, Object.values(CHANNELS), `${label}.channel`),
    tags: [...defaults.tags, ...(sound.tags === undefined ? [] : tags(sound.tags, `${label}.tags`))],
    volume: optional(sound.volume, volume, `${label}.volume`),
    repeat: optional(sound.repeat, boolean, `${label}.repeat`),
    // Image-ness is the FilePathField's call (EntryFlags.icon); its error is clear enough as-is.
    icon: optional(sound.icon, nonEmptyString, `${label}.icon`),
    color: optional(sound.color, color, `${label}.color`),
    random: optional(sound.random, random, `${label}.random`)
  };
}

/** @param {unknown} folders @returns {Record<string, string>} Normalised folder path → name. */
function validateFolders(folders) {
  if (folders === undefined) return {};
  if (typeof folders !== "object" || folders === null || Array.isArray(folders)) fail("pack.folders must be an object of folder path → name");
  const out = {};
  for (const [rawPath, name] of Object.entries(folders)) {
    const path = normalizePath(rawPath).replace(/\/+$/, "");
    if (!path) fail(`pack.folders: "${rawPath}" normalises to nothing`);
    out[path] = nonEmptyString(name, `pack.folders["${rawPath}"]`);
  }
  return out;
}

/** @param {unknown} groups @returns {Record<string, string>} Normalised tag → group name. */
function validateTagGroups(groups) {
  if (groups === undefined) return {};
  if (typeof groups !== "object" || groups === null || Array.isArray(groups)) fail("pack.tagGroups must be an object of tag → group");
  const out = {};
  for (const [rawTag, group] of Object.entries(groups)) {
    const tag = normalizeTag(rawTag);
    if (!tag) fail(`pack.tagGroups: "${rawTag}" normalises to nothing`);
    out[tag] = nonEmptyString(group, `pack.tagGroups["${rawTag}"]`);
  }
  return out;
}

/**
 * Validate a whole import spec and return the normalised form import() and the pack runner work
 * from. Throws on the first problem, naming it.
 * @param {object} spec
 * @returns {object}
 */
function validateSpec(spec) {
  if (typeof spec !== "object" || spec === null) fail("spec must be an object");
  const kind = oneOf(spec.kind, Object.keys(SECTION_FOR_KIND), "kind");
  if (spec.shuffle !== undefined && kind !== CONTAINER_KINDS.PLAYLIST) fail(`shuffle applies to kind "${CONTAINER_KINDS.PLAYLIST}" only`);
  if (!Array.isArray(spec.sounds)) fail("sounds must be an array");
  const defaults = {
    channel: spec.channel === undefined ? undefined : oneOf(spec.channel, Object.values(CHANNELS), "channel"),
    tags: spec.tags === undefined ? [] : tags(spec.tags, "tags")
  };
  return {
    kind,
    name: nonEmptyString(spec.name, "name"),
    color: optional(spec.color, color, "color"),
    favorite: optional(spec.favorite, boolean, "favorite"),
    fade: optional(spec.fade, fade, "fade"),
    shuffle: optional(spec.shuffle, boolean, "shuffle"),
    sounds: spec.sounds.map((sound, i) => validateSound(sound, i, defaults))
  };
}

/* -------------------------------------------- */
/*  Building                                    */
/* -------------------------------------------- */

/**
 * A pack's container is found by its provenance flag, never by name — the name is the GM's from
 * the moment it exists. A macro's (no pack) is found by name, among containers that carry no
 * pack: it must not adopt a pack's board just because the two happen to share a name.
 */
function findContainer(kind, name, pack) {
  return getContainers(kind).find(container => {
    const own = readContainerFlags(container).pack;
    return pack ? (own?.id === pack.id && own?.key === pack.key) : (!own && container.name === name);
  }) ?? null;
}

/**
 * Register the sounds' paths in the catalogue. A path already there keeps its row — name,
 * channel, volume are the GM's — but gains the spec's tags, so a pack does not silently lose its
 * tags on a file the GM had registered before it arrived. A sync overwrites those three where the
 * spec defines them; tags still only ever merge, so a GM's own tag on a pack's file survives.
 * @param {object[]} sounds Validated.
 * @param {{overwrite?: boolean}} [options]
 * @returns {number} Rows added, or on a sync, rows added or rewritten.
 */
function registerRows(sounds, { overwrite = false } = {}) {
  const fresh = [];
  let rewritten = 0;
  for (const sound of sounds) {
    const row = library.getEntry(sound.path);
    if (!row) {
      fresh.push({ path: sound.path, name: sound.name, channel: sound.channel, tags: sound.tags, volume: sound.volume });
      continue;
    }
    if (overwrite) {
      const changes = definedOf({ name: sound.name, channel: sound.channel, volume: sound.volume });
      if (Object.keys(changes).length && library.updateEntry(sound.path, changes)) rewritten++;
    }
    // Only when the spec brings a tag the row lacks: setTags() persists and notifies, and a pack
    // runs on every load — a few thousand rows that already carry their tags must cost nothing.
    if (sound.tags.some(tag => !row.tags.includes(tag))) library.setTags(sound.path, [...row.tags, ...sound.tags]);
  }
  // One call: one persist and one library-changed notification for the whole spec.
  if (fresh.length) library.addEntries(fresh);
  return fresh.length + rewritten;
}

/** The keys of `object` whose value is not undefined — a spec's opinion, and nothing else. */
function definedOf(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/**
 * The PlaylistSound creation data for one sound: the library row's own fields (soundSpecFor, as
 * the console uses), with the spec's opinion on top where it has one. `flags` is left plain;
 * createEntries() runs it through buildEntryFlags() itself.
 */
function entrySpecFor(sound, kind) {
  const row = library.getEntry(sound.path);
  const flags = definedOf({ random: sound.random, icon: sound.icon, color: sound.color });
  return {
    ...soundSpecFor(row),
    name: sound.name ?? row.name,
    channel: sound.channel ?? row.channel,
    volume: sound.volume ?? row.volume,
    // A mixing-desk layer loops by default; a track or a pad plays once — the console's own
    // defaults, from the `toSpec` of console-normal.js's CONTAINER_SECTIONS.
    repeat: sound.repeat ?? (kind === CONTAINER_KINDS.AMBIENCE),
    flags
  };
}

/**
 * The creation data for the spec's sounds not in `present`, and the paths that were. A spec that
 * lists one path twice yields it once.
 * @param {object} spec Validated.
 * @param {Set<string>} [present] Paths the container already holds.
 * @returns {{specs: object[], skipped: string[]}}
 */
function pendingEntries(spec, present = new Set()) {
  const specs = [];
  const skipped = [];
  for (const sound of spec.sounds) {
    if (present.has(sound.path)) {
      skipped.push(sound.path);
      continue;
    }
    present.add(sound.path);
    specs.push(entrySpecFor(sound, spec.kind));
  }
  return { specs, skipped };
}

/**
 * Add the spec's sounds the container does not hold yet. What is already there is left exactly as
 * it is, listed in `skipped`.
 * @returns {Promise<{added: PlaylistSound[], skipped: string[]}>}
 */
async function addMissingEntries(container, spec) {
  const present = new Set(getEntries(container).map(sound => normalizePath(sound.path)));
  const { specs, skipped } = pendingEntries(spec, present);
  const added = specs.length ? await createEntries(container, specs) : [];
  return { added, skipped };
}

/**
 * Container-level fields in one update, and only the ones the spec set: favorite and color are
 * flags written whole (spread the current scope first), fade and mode are document fields.
 */
async function applyContainerFields(container, spec) {
  const update = { _id: container.id };
  const flags = definedOf({ favorite: spec.favorite, color: spec.color });
  if (Object.keys(flags).length) {
    update.flags = { [MODULE_ID]: buildContainerFlags({ ...readContainerFlags(container), ...flags }) };
  }
  if (spec.fade !== undefined) update.fade = spec.fade;
  if (spec.shuffle !== undefined) {
    const modes = foundry.CONST.PLAYLIST_MODES;
    update.mode = spec.shuffle ? modes.SHUFFLE : modes.SEQUENTIAL;
  }
  if (Object.keys(update).length === 1) return;
  await updateContainers([update]);
}

/* -------------------------------------------- */
/*  Public surface                              */
/* -------------------------------------------- */

/**
 * Build one container, fully configured, from a spec — see docs/API.md for the shape. Add-only:
 * a container that already exists is reused, its sounds already present are skipped, and library
 * rows already catalogued keep everything but gain the spec's tags. Running it twice is a no-op.
 * @param {object} spec
 * @param {{pack?: {id: string, key: string}}} [options] Set by the pack runner alone: a macro
 *   calling this directly leaves it out and the container carries `pack: null`.
 * @returns {Promise<{container: Playlist, created: boolean, added: PlaylistSound[], skipped: string[]}>}
 */
export async function importContainer(spec, { pack = null } = {}) {
  assertWritable();
  const valid = validateSpec(spec);

  // Rows first: entrySpecFor() reads them.
  registerRows(valid.sounds);

  let container = findContainer(valid.kind, valid.name, pack);
  const created = !container;
  let added;
  let skipped;
  if (created) {
    // The sounds go in with the create call — one round-trip per container, which is what makes a
    // pack of several hundred bearable on its first load.
    ({ specs: added, skipped } = pendingEntries(valid));
    [container] = await createContainers([{
      name: valid.name,
      kind: valid.kind,
      color: valid.color ?? null,
      folder: getSectionFolder(SECTION_FOR_KIND[valid.kind])?.id ?? null,
      pack,
      sounds: added
    }]);
    if (!container) fail(`could not create "${valid.name}"`);
    added = getEntries(container);
    // Colour and sounds went in with the create call; the rest cannot.
    await applyContainerFields(container, { ...valid, color: undefined });
  } else {
    ({ added, skipped } = await addMissingEntries(container, valid));
  }

  // The store debounces. A pack whose registration finishes before the timer fires must not lose
  // its rows to a reload.
  await library.flushSave();
  return { container, created, added, skipped };
}

/**
 * Register files in the library — with tags and channel — without building a container. For a
 * pack that ships tagged audio and leaves the boards to the GM.
 * @param {{path: string, name?: string, channel?: string, tags?: string[], volume?: number}[]} entries
 * @returns {Promise<object[]>} The rows actually added; already-catalogued paths are not among them.
 */
export async function addLibraryEntries(entries) {
  assertWritable();
  if (!Array.isArray(entries)) fail("entries must be an array");
  const sounds = entries.map((entry, i) => validateSound(entry, i, { channel: undefined, tags: [] }));
  const before = new Set(sounds.map(s => s.path).filter(path => library.getEntry(path)));
  registerRows(sounds);
  await library.flushSave();
  return sounds.filter(s => !before.has(s.path)).map(s => library.getEntry(s.path)).filter(Boolean);
}

/**
 * What a content module calls, from its own `setup` hook (after every module's `init`, so the
 * global is there whatever the script order): record what it ships. No writes happen
 * here — main.js runs every registered pack through importContainer() once the library is
 * loaded, one container at a time, so the module author writes no hook of their own.
 *
 * Specs are validated now rather than at run time: a bad one should fail in the pack author's
 * console at load, not in the GM's a hook later.
 * @param {{id: string, name: string, containers: object[], library?: object[],
 *   folders?: Record<string, string>, tagGroups?: Record<string, string>}} pack `id` is the
 *   module's own id. `library` is files to catalogue without a container — the same shape
 *   library.add() takes. `folders` names folders in the Library tab's tree (folder path → display
 *   name) whose on-disk name is a slug. `tagGroups` sorts the pack's tags into facets (tag →
 *   group name), which is what makes two tags of the same group widen a filter instead of
 *   narrowing it; a tag left out of it stays ungrouped and keeps narrowing on its own.
 */
export function registerPack(pack) {
  if (typeof pack !== "object" || pack === null) fail("pack must be an object");
  const id = nonEmptyString(pack.id, "pack.id");
  // An inactive pack's audio paths would 404; a typo here should fail loudly rather than register
  // a pack nobody can find later.
  if (!game.modules.get(id)?.active) fail(`pack.id "${id}" is not an active module`);
  const name = nonEmptyString(pack.name, "pack.name");
  if (!Array.isArray(pack.containers)) fail("pack.containers must be an array");
  const containers = pack.containers.map(validateSpec);
  if (pack.library !== undefined && !Array.isArray(pack.library)) fail("pack.library must be an array");
  const entries = (pack.library ?? []).map((entry, i) => validateSound(entry, i, { channel: undefined, tags: [] }));
  const folders = validateFolders(pack.folders);
  const tagGroups = validateTagGroups(pack.tagGroups);
  // Replace, not append: a module re-registering after a hot reload must not double up.
  packs.set(id, { id, name, containers, library: entries, folders, tagGroups });
}

/**
 * Make a pack's containers match its spec again — the GM's explicit way of taking a newer pack
 * version's changes, from the Library maintenance settings app. Touches only what the pack built
 * (found by the provenance flag, never by name) and only the fields the spec defines: a sound
 * whose spec omits `volume` keeps the GM's. Names are never written. A sound the GM added to a
 * pack's board, and a board the GM built, are not in any spec and are not touched. A container
 * the GM deleted is built again.
 * @param {string} id A registered pack's id.
 * @returns {Promise<{containers: number, entriesUpdated: number, entriesAdded: number, rowsUpdated: number}>}
 */
export async function syncPack(id) {
  assertWritable();
  const pack = packs.get(id);
  if (!pack) fail(`no pack registered as "${id}"`);
  const counts = { containers: 0, entriesUpdated: 0, entriesAdded: 0, rowsUpdated: 0 };
  counts.rowsUpdated += registerRows(pack.library, { overwrite: true });
  library.setFolderNames(pack.folders);
  library.setTagGroups(pack.tagGroups);

  for (const spec of pack.containers) {
    const provenance = { id: pack.id, key: spec.name };
    const container = findContainer(spec.kind, spec.name, provenance);
    if (!container) {
      const result = await importContainer(spec, { pack: provenance });
      counts.containers++;
      counts.entriesAdded += result.added.length;
      continue;
    }

    await applyContainerFields(container, spec);
    counts.rowsUpdated += registerRows(spec.sounds, { overwrite: true });

    const byPath = new Map(getEntries(container).map(sound => [normalizePath(sound.path), sound]));
    const updates = [];
    for (const sound of spec.sounds) {
      const existing = byPath.get(sound.path);
      if (!existing) continue;
      const update = definedOf({ name: sound.name, channel: sound.channel, volume: sound.volume, repeat: sound.repeat });
      const flags = definedOf({ random: sound.random, icon: sound.icon, color: sound.color });
      // Spread the current scope first: a flag write replaces the whole of it, and a flag the
      // spec does not define is the GM's, never a pack's.
      // random merges one level deeper for the same reason: a key the pack leaves out of it (an
      // onStart the GM toggled, say) stays as the GM set it.
      const current = readEntryFlags(existing);
      if (flags.random) flags.random = { ...current.random, ...flags.random };
      if (Object.keys(flags).length) update.flags = { [MODULE_ID]: buildEntryFlags({ ...current, ...flags }) };
      if (Object.keys(update).length) updates.push({ _id: existing.id, ...update });
    }
    if (updates.length) await updateEntries(container, updates);
    counts.entriesUpdated += updates.length;

    const { added } = await addMissingEntries(container, spec);
    counts.containers++;
    counts.entriesAdded += added.length;
  }

  await library.flushSave();
  return counts;
}

/**
 * @returns {{id: string, name: string, containers: object[], library: object[], folders: Record<string, string>, tagGroups: Record<string, string>}[]} Registered packs, by name.
 */
export function getPacks() {
  return [...packs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build every registered pack. Each container in its own try/catch: one bad spec must not stop
 * the rest of its pack, and a bad pack must not stop the console from opening.
 * @returns {Promise<void>}
 */
export async function runRegisteredPacks() {
  for (const pack of packs.values()) {
    // Every row of the pack in one pass and one write, so importContainer() below finds each
    // already catalogued and has nothing to persist: a pack of a few hundred containers would
    // otherwise rewrite a multi-megabyte library.json once per container on its first build.
    try {
      registerRows([...pack.library, ...pack.containers.flatMap(spec => spec.sounds)]);
      library.setFolderNames(pack.folders, { overwrite: false });
      // Before the rows, so a tag arrives already in its facet rather than being coined ungrouped
      // by the first row that carries it and only then moved.
      library.setTagGroups(pack.tagGroups, { overwrite: false });
      await library.flushSave();
    } catch (err) {
      console.error(`${MODULE_ID} | pack "${pack.id}" failed to catalogue its library entries`, err);
    }
    for (const spec of pack.containers) {
      try {
        await importContainer(spec, { pack: { id: pack.id, key: spec.name } });
      } catch (err) {
        console.error(`${MODULE_ID} | pack "${pack.id}" failed to build "${spec.name}"`, err);
      }
    }
  }
}
