/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { dirnameOf } from "../helpers.js";
import { getFolderName } from "../library/index.js";

// The folder-tree model and indent gutter shared by every list in this module that shows library
// rows grouped by their own path — the Library tab's virtualised table (console-normal.js) and the
// "Add from Library" picker (library-picker.js). Two lists that fold the same way must not have
// two copies of the folding, or they drift apart visually.
//
// Nothing here touches the catalogue or the DOM: it takes rows in, gives a flattened row list (or a
// gutter string) back, and leaves rendering to the caller — each surface renders a different row
// body over the same structure.

// Width in pixels of one indent-gutter column — one per nesting level. Matched by --ac-tree-col,
// which each consumer sets on its own list element rather than the stylesheet hardcoding it.
export const TREE_INDENT = 16;

// Intl.Collator is an order of magnitude faster than String#localeCompare per call, which matters
// when the comparison runs over a few thousand rows on every filter change.
let collator = null;

/** @param {{name: string}} a @param {{name: string}} b @returns {number} */
export function byName(a, b) {
  collator ??= new Intl.Collator(game.i18n.lang);
  return collator.compare(a.name, b.name);
}

/**
 * Group library rows into a folder tree, read straight off each entry's own path — nothing in
 * library.json stores a folder separately, so a "Scan folder" import respects the directory
 * structure it found things in for free, and an individually added file with no directory just
 * sits loose at the root.
 * @param {object[]} entries
 * @returns {{name: string, path: string, children: Map<string, object>, entries: object[]}}
 */
export function buildFolderTree(entries) {
  const root = { name: "", path: "", children: new Map(), entries: [] };
  for (const entry of entries) {
    const dir = dirnameOf(entry.path);
    let node = root;
    if (dir) {
      let walked = "";
      for (const { segment, name } of folderSegments(dir)) {
        walked = walked ? `${walked}/${segment}` : segment;
        let child = node.children.get(segment);
        if (!child) {
          // A pack may have named this folder (library.setFolderNames); otherwise the segment.
          child = { name: getFolderName(walked) ?? name, path: walked, children: new Map(), entries: [] };
          node.children.set(segment, child);
        }
        node = child;
      }
    }
    node.entries.push(entry);
  }
  return root;
}

/**
 * A directory as the tree walks it: one step per path segment — except that a content module's
 * `modules/<id>` is one step, shown under the module's title. Every file a pack ships sits under
 * that prefix, so read literally it would give the GM a "modules" folder holding an id-named
 * folder before anything of theirs appears; the module's name alone is the folder they think of.
 * The node's `path` stays `modules/<id>`, so collapse state and "remove folder" (a path-prefix
 * match) work exactly as for any other folder.
 * @param {string} dir
 * @returns {{segment: string, name: string}[]}
 */
function folderSegments(dir) {
  const segments = dir.split("/");
  if ((segments[0] !== "modules") || (segments.length < 2)) return segments.map(segment => ({ segment, name: segment }));
  const id = segments[1];
  return [
    { segment: `modules/${id}`, name: game.modules.get(id)?.title ?? id },
    ...segments.slice(2).map(segment => ({ segment, name: segment }))
  ];
}

/** Entries anywhere under a folder tree node, nested subfolders included. @returns {number} */
export function countFolderEntries(node) {
  let count = node.entries.length;
  for (const child of node.children.values()) count += countFolderEntries(child);
  return count;
}

/** Folder paths anywhere under a node, at any depth, the node itself excluded. @returns {string[]} */
export function collectFolderPaths(node) {
  const paths = [];
  for (const child of node.children.values()) {
    paths.push(child.path);
    paths.push(...collectFolderPaths(child));
  }
  return paths;
}

/**
 * Flatten a tree depth-first into the row list a list widget paints: a folder header row followed
 * immediately by its own rows (subfolders first, alphabetically, then its own entries,
 * alphabetically) unless it is collapsed, in which case its whole subtree is simply never appended
 * — the same mechanism that lets virtualisation skip rows outside the scroll window skips a
 * collapsed folder's rows for free.
 * @param {object} root From buildFolderTree.
 * @param {Set<string>} collapsed Folder paths currently collapsed.
 * @returns {object[]} `{kind: "folder", …}` and `{kind: "entry", entry, depth, last}` rows.
 */
export function flattenFolderTree(root, collapsed) {
  const rows = [];
  const flatten = (node, depth) => {
    for (const child of [...node.children.values()].sort(byName)) {
      // A row-level "collapse subfolders" control needs this folder's whole descendant subtree,
      // not just its own path — collected once here from the still-intact children Map, rather
      // than re-walked at click time.
      const descendantFolders = collectFolderPaths(child);
      rows.push({
        kind: "folder",
        path: child.path,
        name: child.name,
        depth,
        count: countFolderEntries(child),
        descendantFolders,
        subfoldersCollapsed: descendantFolders.length > 0
          && descendantFolders.every(path => collapsed.has(path))
      });
      if (!collapsed.has(child.path)) flatten(child, depth + 1);
    }
    // Sibling entries of the same folder are always pushed as one contiguous run (every
    // subfolder's own subtree above has already been flattened by this point), so "last" here just
    // means last in this one sort — nothing to reconcile against rows pushed earlier.
    const entries = [...node.entries].sort(byName);
    entries.forEach((entry, i) => rows.push({ kind: "entry", entry, depth, last: i === entries.length - 1 }));
  };
  flatten(root, 0);
  return rows;
}

/**
 * The indent gutter shared by folder and entry rows: one TREE_INDENT column per nesting level,
 * blank at depth 0. Folders get plain spacer columns — a folder's open/closed state lives entirely
 * on its own icon (.claude/rules/ui-patterns.md), so it carries
 * no line of its own, not even one marking its position under a parent. Every ancestor level above
 * a leaf is a blank spacer for the same reason: the marker traces this one folder's run of sound
 * files, not the hierarchy above it. Only a leaf's own column draws a line, running the full row
 * height ("├") into the next sound file when one follows in the same folder, or stopping at the
 * row's own midline ("└", `last`) when this is the last of them — so consecutive files read as one
 * connected run, not separate ticks.
 * @param {number} depth
 * @param {boolean} [leaf]
 * @param {boolean} [last]
 * @returns {string}
 */
export function renderTreeGutter(depth, leaf = false, last = false) {
  if (depth === 0) return "";
  let html = "";
  for (let i = 0; i < depth - 1; i++) html += `<span class="ac-tree-col"></span>`;
  html += `<span class="ac-tree-col${leaf ? ` leaf${last ? " last" : ""}` : ""}"></span>`;
  return `<span class="ac-tree-gutter">${html}</span>`;
}
