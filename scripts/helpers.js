/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MAX_TAG_LENGTH, MIN_TAG_LENGTH, MODULE_ID } from "./constants.js";

/**
 * The FilePicker class to instantiate or call statics on. Resolved at call time rather than
 * imported, so a host environment that substitutes its own picker (S3, a VTT host's asset
 * browser) is not bypassed — the one FilePicker rule in CLAUDE.md, kept in one place.
 * @returns {typeof foundry.applications.apps.FilePicker}
 */
export function filePickerClass() {
  return foundry.applications.apps.FilePicker.implementation ?? foundry.applications.apps.FilePicker;
}

/**
 * Whether this client may write: documents, the catalogue file, a broadcast. All of them are
 * GM-only, and the server would reject a player's attempt anyway — failing here gives a clear
 * message instead of a permission error surfacing from deep inside Foundry.
 * @param {string} operation For the warning.
 * @returns {boolean}
 */
export function canWrite(operation) {
  if (game.user.isGM) return true;
  console.warn(`${MODULE_ID} | refusing ${operation}: GM only`);
  return false;
}

// Path handling. Foundry stores PlaylistSound#path already URL-encoded — spaces arrive as %20
// (confirmed against real library data). Never treat a stored path as a plain string: use
// normalizePath to compare, toFetchUrl to request, basenameOf to display.

/**
 * The canonical form of a path: decoded, no leading slash. This is the library index key, so
 * "Car%20Crash.mp3" and "Car Crash.mp3" resolve to the same track.
 * Case-sensitive on purpose — Foundry data paths are, on Linux hosts.
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  if (!path) return "";
  let decoded;
  try { decoded = decodeURI(path); } catch { decoded = path; } // malformed % sequences
  return decoded.replace(/^\/+/, "");
}

/**
 * The only form that may be handed to fetch(). Decoding first is what stops an already-encoded
 * %20 from becoming %2520 and 404ing.
 *
 * Per segment, with the *Component pair, not encodeURI(normalizePath()). decodeURI leaves the
 * characters URLs reserve (# & + = ? , ; : @ $) encoded, so a stored "Pasta%20%231" came back as
 * "Pasta #%231" and encodeURI then turned that % into %25: every file with one of those in its
 * name or folder was requested as %2523, 404'd, and read as Missing while core — which plays the
 * stored path as-is — played it fine (measured in v14.368). The same request fed duration, preview
 * and whisper. Splitting on "/" first keeps an encoded %2F inside a segment rather than turning it
 * into a separator.
 *
 * A remote URL keeps the old treatment: its scheme and host are not path segments.
 * @param {string} path
 * @returns {string}
 */
export function toFetchUrl(path) {
  if (!path) return "";
  if (isRemotePath(path)) return encodeURI(normalizePath(path));
  return path.replace(/^\/+/, "").split("/").map(segment => {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { decoded = segment; } // a bare "%", e.g. "50% off"
    return encodeURIComponent(decoded);
  }).join("/");
}

/**
 * Last segment of a path, decoded. The only input slugify() is ever given.
 * @param {string} path
 * @returns {string}
 */
export function basenameOf(path) {
  return normalizePath(path).split("/").pop();
}

/**
 * Everything before the last segment, decoded — the directory a path lives in. "" for a path with
 * no directory (a file registered from the data root). Nothing in library.json stores a folder of
 * its own; the library's folder tree (console-normal.js) is read straight off this, the same
 * directory structure scanFolder() found each file at.
 * @param {string} path
 * @returns {string}
 */
export function dirnameOf(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

/**
 * Kebab-case a display string. Foundry's String#slugify carries the accent map, so "Ação"
 * becomes "acao" rather than losing the letters entirely.
 *
 * Expects decoded text — pass basenameOf(path), never a raw stored path. Strict mode also drops
 * the dot in an extension ("Mar.mp3" → "marmp3"), so split the extension off before slugifying a
 * filename and re-append it afterwards.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return String(text ?? "").trim().slugify({ strict: true }).replace(/-{2,}/g, "-");
}

/**
 * A readable default name from a filename, for when the GM adds a file without typing one:
 * strip the extension, turn separators into spaces, title-case each word. Expects decoded text —
 * pass basenameOf(path), same rule as slugify().
 * @param {string} basename
 * @returns {string}
 */
export function humanizeName(basename) {
  return String(basename ?? "")
    .replace(/\.[^./]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\p{L}[\p{L}\p{N}']*/gu, word => word[0].toUpperCase() + word.slice(1));
}

/**
 * A default name for a new container left unnamed at creation: the base word alone if free,
 * otherwise the base word with the lowest free trailing number ("Playlist", "Playlist 2", …).
 * @param {string} base
 * @param {string[]} existingNames
 * @returns {string}
 */
export function nextDefaultName(base, existingNames) {
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/**
 * Seconds as m:ss, or h:mm:ss past an hour. For the transport bar's elapsed/total readout, which
 * is the only place in the module that knows a duration — it comes off the loaded Sound.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || (seconds < 0)) return "–:––";
  const total = Math.floor(seconds);
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * Bytes as a human-readable size, for the consolidate preview — a GM judging whether to duplicate
 * a library's worth of disk needs "1.4 GB", not a nine-digit number. Binary units, matching what
 * an operating system's file manager reports for the same folder.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || (bytes < 0)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while ((value >= 1024) && (unit < (units.length - 1))) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed((unit === 0) || (value >= 100) ? 0 : 1)} ${units[unit]}`;
}

/**
 * A path this module cannot fetch or verify from the client: a cross-origin URL fails CORS
 * regardless of whether the file is actually there, so there is nothing a HEAD probe or a copy
 * can tell about it. Matches any URI scheme, so an S3-backed path is treated the same way
 * consolidate.js already treats it.
 * @param {string} path
 * @returns {boolean}
 */
export function isRemotePath(path) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

/**
 * A tag is a lowercase [a-z0-9-] string and nothing else, cut to MAX_TAG_LENGTH. Returns "" for
 * anything that normalises away, which callers drop.
 * @param {string} tag
 * @returns {string}
 */
export function normalizeTag(tag) {
  const slug = slugify(tag).replace(/^-+|-+$/g, "");
  // Stripped again after slicing: cutting mid-run can leave a trailing "-" the first strip never
  // saw, e.g. "combat-" from slicing "combat-heavy" at 7.
  return slug.slice(0, MAX_TAG_LENGTH).replace(/-+$/g, "");
}

/**
 * Normalise a list of tags: drop empties, drop duplicates, keep first-seen order.
 * @param {string[]} tags
 * @returns {string[]}
 */
export function normalizeTags(tags) {
  const seen = new Set();
  for (const tag of tags ?? []) {
    const normalized = normalizeTag(tag);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/**
 * Normalise a list of tags as typed by a GM, dropping anything shorter than MIN_TAG_LENGTH. No
 * word is reserved: an entry's audio channel is its own field (constants.js CHANNELS), so "music"
 * is an ordinary tag like any other. Catalogue load and import merge keep using normalizeTags()
 * directly — a tag already on disk is kept whatever its length.
 * @param {string[]} tags
 * @returns {string[]}
 */
export function sanitizeUserTags(tags) {
  return normalizeTags(tags).filter(tag => tag.length >= MIN_TAG_LENGTH);
}

/**
 * The audio channel a PlaylistSound actually sounds on: its own, else its playlist's, else music.
 * This is core's own resolution order (PlaylistSound#effectiveContext, v14
 * client/documents/playlist-sound.mjs) — worth mirroring exactly, because an entry whose channel
 * is blank inherits one at play time and anything replaying it outside the document path (a
 * hotbar macro, a whisper to one player) must inherit the same one.
 * @param {PlaylistSound} sound
 * @returns {string} One of CONST.AUDIO_CHANNELS.
 */
export function effectiveChannel(sound) {
  return sound?.channel || sound?.parent?.channel || "music";
}
