/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID, FLAGS, CHANNELS, CONTAINER_KINDS, DEFAULT_CHANNEL, SECTIONS } from "../constants.js";

const fields = foundry.data.fields;

/**
 * flags["audio-console"] on a section Folder.
 */
export class SectionFlags extends foundry.abstract.DataModel {
  static defineSchema() {
    return {
      section: new fields.StringField({
        required: true,
        blank: false,
        choices: Object.values(SECTIONS),
        initial: SECTIONS.ROOT
      })
    };
  }
}

/**
 * flags["audio-console"] on a container Playlist — a playlist, soundboard, ambience, or the
 * Now Playing queue.
 */
export class ContainerFlags extends foundry.abstract.DataModel {
  static defineSchema() {
    return {
      kind: new fields.StringField({
        required: true,
        blank: false,
        choices: Object.values(CONTAINER_KINDS),
        initial: CONTAINER_KINDS.PLAYLIST
      }),
      // ColorField#toObject() hands back the plain "#rrggbb" string the plan specifies, not a
      // Color instance — verified in a live v14 world.
      color: new fields.ColorField({ required: false, nullable: true, initial: null }),
      // Pinned to the rail's Favorites list. On the document rather than in a client setting: it
      // belongs to the container the way `kind` and `color` do, so it survives a world export and
      // a second GM sees the same pins.
      favorite: new fields.BooleanField({ initial: false }),
      // Which content module built this container through the public API (api.js), and the name
      // its spec gave it at the time — null on anything the GM made in the console. A pack sync
      // finds its containers by this pair, not by name: the name belongs to the GM from the moment
      // it exists, and renaming a board must not turn it into a stranger the next sync recreates.
      pack: new fields.SchemaField({
        id: new fields.StringField({ required: true, blank: false }),
        key: new fields.StringField({ required: true, blank: false })
      }, { required: false, nullable: true, initial: null }),
      // Soundboards only: while one of this board's pads plays, every client lowers its music
      // channel (audio/ducking.js). On the document so every client sees the same answer.
      duck: new fields.BooleanField({ initial: false }),
      // Ambiences only: switched on. Not the same as Playlist#playing, which core derives from the
      // sounds (v14.368, confirmed live) — an ambience whose only sounding layers are on a random interval
      // reads as stopped between fires, and the random scheduler would never fire it again.
      active: new fields.BooleanField({ initial: false })
    };
  }
}

/**
 * flags["audio-console"] on a PlaylistSound. Entries carry no tags: tags belong to the library row
 * for that path and are resolved at render time (library/index.js).
 */
export class EntryFlags extends foundry.abstract.DataModel {
  static defineSchema() {
    return {
      random: new fields.SchemaField({
        enabled: new fields.BooleanField({ initial: false }),
        // Seconds, the centre of the range. NumberField min/max clamp during cleaning rather
        // than rejecting (verified in v14), so a mistyped 0 lands on the 2 s floor instead of
        // becoming a playback loop that hammers the database.
        interval: new fields.NumberField({ required: true, nullable: false, initial: 60, min: 2 }),
        // Fraction of the interval: 0.5 → interval × (1 ± 0.5). Clamped to 0–1 the same way.
        variance: new fields.NumberField({ required: true, nullable: false, initial: 0.5, min: 0, max: 1 }),
        // Ambience layers only: also play the moment the ambience starts. Off, the layer's first
        // fire lands somewhere inside its first interval instead (random-scheduler.js), so a scene
        // does not open with every timed layer at once.
        onStart: new fields.BooleanField({ initial: false })
      }),
      // Soundboard pads only: an optional accent colour for the pad face. Same
      // ColorField pattern as ContainerFlags.color — #toObject() gives a plain "#rrggbb" string,
      // not a Color instance. Not part of the original entry flag sketch; added here because pad
      // config has nowhere else to store it.
      color: new fields.ColorField({ required: false, nullable: true, initial: null }),
      // Soundboard pads only: the image the pad face shows. Any image core or a module ships, or
      // anything the GM has uploaded — a FilePathField validates the extension for us, so a path
      // that is not an image never reaches the database. null means "no choice made"; the console
      // falls back to DEFAULT_PAD_ICON rather than storing that default on every pad, so changing
      // the default later reaches pads that were never configured.
      icon: new fields.FilePathField({ categories: ["IMAGE"], required: false, nullable: true, initial: null })
    };
  }
}

/**
 * A row of Data/audio-console/library.json. Not a flag — this validates the catalogue file, not a
 * document flag scope — but it lives here so every DataModel-validated shape in the module has one
 * home. Paths are stored as given; normalisation to the index key happens in library/index.js via
 * normalizePath(), not here.
 */
export class LibraryEntry extends foundry.abstract.DataModel {
  static defineSchema() {
    return {
      path: new fields.StringField({ required: true, blank: false }),
      name: new fields.StringField({ required: true, blank: false }),
      // Which mixer channel this entry plays on. A field with `choices`, so an unknown value is
      // refused at the door — this is routing, and a row that routes nowhere is not a row with a
      // cosmetic problem. Tags carry no part of this any more: they are free text, optional and
      // repeatable, and none of them is reserved.
      channel: new fields.StringField({
        required: true, blank: false, choices: Object.values(CHANNELS), initial: DEFAULT_CHANNEL
      }),
      tags: new fields.ArrayField(new fields.StringField({ blank: false }), { initial: [] }),
      // AlphaField is 0-1 by construction, matching PlaylistSound#volume's own field type.
      volume: new fields.AlphaField({ required: true, nullable: false, initial: 0.8 })
    };
  }
}

/**
 * Validate one catalogue row on load. Unlike the flag readers, a bad row is dropped rather than
 * defaulted — a library entry with a made-up path or a missing/duplicated type tag is not a
 * "slightly wrong card", it is data that doesn't mean anything.
 * @param {object} raw
 * @returns {object|null} The validated row, or null if it should be dropped.
 */
export function validateLibraryEntry(raw) {
  try {
    return new LibraryEntry(raw).toObject();
  } catch (err) {
    console.warn(`${MODULE_ID} | dropped a malformed library row`, raw, err);
    return null;
  }
}

/**
 * Build a library row for a write. Throws on invalid input — this is our own code constructing
 * the row, so a validation failure here is a bug, not a GM's hand-edit.
 * @param {object} data
 * @returns {object}
 */
export function buildLibraryEntry(data) {
  return new LibraryEntry(data).toObject();
}

/**
 * Normalise a raw flag payload through its model without ever throwing. DataModel validation
 * throws by design; a GM who hand-edited a flag in a third-party inspector should get a slightly
 * wrong card, not a dead UI.
 * @param {typeof foundry.abstract.DataModel} ModelClass
 * @param {object|undefined} raw
 * @param {foundry.abstract.Document} [document] Only for the warning message.
 * @returns {object}
 */
function readThrough(ModelClass, raw, document) {
  try {
    return new ModelClass(raw ?? {}).toObject();
  } catch (err) {
    console.warn(`${MODULE_ID} | malformed ${ModelClass.name} on ${document?.uuid ?? "unknown document"}`, err);
    return new ModelClass({}).toObject();
  }
}

/**
 * @param {Folder} folder
 * @returns {{section: string}}
 */
export function readSectionFlags(folder) {
  return readThrough(SectionFlags, {
    section: folder?.getFlag(MODULE_ID, FLAGS.SECTION)
  }, folder);
}

/**
 * These readers fill in defaults, so an unflagged document reads back as a valid-looking
 * container. Membership is decided by repository.js first; only then are the flags read.
 * @param {Playlist} playlist
 * @returns {{kind: string, color: string|null, favorite: boolean, pack: {id: string, key: string}|null,
 *   duck: boolean, active: boolean}}
 */
export function readContainerFlags(playlist) {
  return readThrough(ContainerFlags, {
    kind: playlist?.getFlag(MODULE_ID, FLAGS.KIND),
    color: playlist?.getFlag(MODULE_ID, FLAGS.COLOR),
    favorite: playlist?.getFlag(MODULE_ID, FLAGS.FAVORITE),
    pack: playlist?.getFlag(MODULE_ID, FLAGS.PACK),
    duck: playlist?.getFlag(MODULE_ID, FLAGS.DUCK),
    active: playlist?.getFlag(MODULE_ID, FLAGS.ACTIVE)
  }, playlist);
}

/**
 * @param {PlaylistSound} sound
 * @returns {{random: {enabled: boolean, interval: number, variance: number, onStart: boolean}, color: string|null,
 *   icon: string|null}}
 */
export function readEntryFlags(sound) {
  return readThrough(EntryFlags, {
    random: sound?.getFlag(MODULE_ID, FLAGS.RANDOM),
    color: sound?.getFlag(MODULE_ID, FLAGS.COLOR),
    icon: sound?.getFlag(MODULE_ID, FLAGS.ICON)
  }, sound);
}

/**
 * Build a flag payload for a write, so bad data cannot reach the database. Throws on invalid
 * input — writes are our own code and a bad one is a bug, not a GM's edit.
 * @param {typeof foundry.abstract.DataModel} ModelClass
 * @param {object} data
 * @returns {object}
 */
function buildThrough(ModelClass, data) {
  return new ModelClass(data).toObject();
}

/** @param {{section: string}} data */
export function buildSectionFlags(data) {
  return buildThrough(SectionFlags, data);
}

/** @param {{kind: string, color?: string|null, favorite?: boolean, pack?: {id: string, key: string}|null, duck?: boolean}} data */
export function buildContainerFlags(data) {
  return buildThrough(ContainerFlags, data);
}

/**
 * @param {{random?: object, color?: string|null, icon?: string|null}} data
 * Callers that already hold a full `readEntryFlags()` result should spread it in before
 * overriding the field they mean to change — this replaces the whole flag scope on write, so an
 * omitted field resets to its schema default rather than staying as it was.
 */
export function buildEntryFlags(data) {
  return buildThrough(EntryFlags, data);
}
