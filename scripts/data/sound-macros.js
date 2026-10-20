/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { CONTAINER_MACRO_ICONS, DEFAULT_PAD_ICON, FLAGS, MODULE_ID, SOUND_DRAG_MARKER } from "../constants.js";
import { basenameOf, effectiveChannel, humanizeName } from "../helpers.js";
import { soundSpecFor } from "../audio/playback.js";
import { readEntryFlags } from "./flag-models.js";
import { containerKindOf, findMacroForContainer, findMacroForPath, getMacroFolder } from "./repository.js";
import { createMacro, createMacroFolder } from "./mutations.js";

// Hotbar macros: a sound's, and a container's (see Containers below — the one exception to
// everything said in the rest of this comment).
//
// A sound as a hotbar macro — a soundboard pad dragged there, or a library row dragged or saved
// from its own button. The macro this produces is a leaving present: it holds a path and the two
// numbers that decide how the sound plays, and calls core's own AudioHelper. Nothing in it imports
// this module, reads a flag of ours or looks up a document, so it keeps working in a world where
// Audio Console is disabled or gone — which is the whole point of putting a sound on the hotbar
// rather than just opening the console.
//
// Everything below takes a PlaylistSound. A pad is one; a library row is not, so it arrives as an
// ephemeral one built from its row (soundForEntry) — never saved, only read. That is also the
// shape core's own drop handling gives a `data` payload (ClientDocumentMixin.fromDropData), so the
// hotbar and the canvas see a library drag and a pad drag as the same kind of thing.
//
// The macro does reach the other clients over game.socket, and it has to: `AudioHelper.play(data,
// true)` emits core's own "playAudio" event, which is the only way to make a sound with no
// document behind it play anywhere but here.
//
// That is not the "no socket anywhere in this module" rule (audio/playback.js) being bent. What
// that rule forbids is *this module* opening a socket of its own to reimplement document
// propagation — module.json still declares "socket": false and nothing emits on
// module.audio-console. A hotbar macro has no document to propagate: one that leaned on a
// PlaylistSound would need the module's containers to still exist, which is exactly what it is
// built not to need. Core's channel, core's listener, and only from inside the macro.

/**
 * The macro body. Written to be read: a GM who opens it should see three settings they recognise
 * from the pad's own config dialog and be able to change them in place.
 *
 * Every value is baked in as a literal at creation time. Re-reading the sound at run time would be
 * the opposite of standing alone, and it would also make the macro lie about what it does once
 * the pad or the library row is deleted.
 * @param {PlaylistSound} sound
 * @returns {string}
 */
function commandFor(sound) {
  // JSON.stringify, not quotes-and-hope: a path arrives URL-encoded but a name is whatever the GM
  // typed, and one apostrophe or line break would otherwise produce a macro that throws on save.
  return [
    `// Audio Console — plays ${JSON.stringify(sound.name)}.`,
    `// Self-contained: this needs no module, only core's audio helper.`,
    `// The trailing \`true\` is what makes every connected client hear it, the way the pad does.`,
    `foundry.audio.AudioHelper.play({`,
    `  src: ${JSON.stringify(sound.path)},`,
    `  channel: ${JSON.stringify(effectiveChannel(sound))},`,
    `  volume: ${JSON.stringify(sound.volume ?? 1)},`,
    `  loop: ${JSON.stringify(!!sound.repeat)}`,
    `}, true);`
  ].join("\n");
}

/**
 * A library row as a PlaylistSound that exists nowhere — the shape everything here reads, built
 * the way core's fromDropData builds one from an inline `data` payload. Same spec the queue and
 * the containers are created from, so a macro made from a row and one made from the pad that row
 * became cannot disagree.
 * @param {object} entry A library row from library/index.js.
 * @returns {PlaylistSound}
 */
export function soundForEntry(entry) {
  return new foundry.documents.PlaylistSound.implementation(soundSpecFor(entry));
}

/**
 * The macro for a sound — the one that already exists for this audio file, or a new one.
 *
 * Reuse is by path alone, so the settings on an existing macro win over the sound being dragged.
 * That is the right way round: the macro is a document the GM may have opened and edited, and
 * silently rewriting it because a different pad on the same file has a different volume would
 * throw that away without asking.
 *
 * @param {PlaylistSound} sound A pad, or a library row via soundForEntry.
 * @returns {Promise<{macro: Macro, created: boolean}|null>} Null if the macro could not be made.
 */
async function macroForSound(sound) {
  const existing = findMacroForPath(sound.path);
  if (existing) return { macro: existing, created: false };

  const folder = getMacroFolder() ?? await createMacroFolder();
  const macro = await createMacro({
    name: sound.name || humanizeName(basenameOf(sound.path)),
    command: commandFor(sound),
    // The pad's own face, so the hotbar slot and the pad read as the same thing. Pads that never
    // had an icon picked fall back here exactly as the pad grid does, rather than storing the
    // default (constants.js DEFAULT_PAD_ICON).
    img: readEntryFlags(sound).icon || DEFAULT_PAD_ICON,
    flags: { [FLAGS.SOUND_PATH]: sound.path },
    folder: folder?.id ?? null
  });
  return macro ? { macro, created: true } : null;
}

/**
 * Make the macro for a sound and leave it in the world, without touching the hotbar.
 *
 * The same macro the hotbar drag produces, reached the other way round. Dragging is the gesture
 * for "I want this on a bar right now"; this is for "I want this to exist" — a GM building a
 * sheet of macros, or handing one to another world, has no use for a hotbar slot and should not
 * have to spend one to get the document.
 *
 * Reuse is macroForSound's, so pressing it twice is not a way to end up with two macros for one
 * file: the second press finds the first and says so.
 *
 * @param {PlaylistSound} sound A pad, or a library row via soundForEntry.
 * @returns {Promise<Macro|null>} The macro, or null when it could not be made.
 */
export async function createSoundMacro(sound) {
  try {
    const result = await macroForSound(sound);
    if (!result) return null;
    ui.notifications.info(game.i18n.format(
      result.created ? "AUDIO_CONSOLE.Soundboard.Notify.MacroSaved" : "AUDIO_CONSOLE.Soundboard.Notify.MacroExists",
      { name: result.macro.name, folder: result.macro.folder?.name ?? "" }
    ));
    return result.macro;
  } catch (err) {
    console.error(`${MODULE_ID} | could not turn a sound into a macro`, err);
    ui.notifications.error(game.i18n.localize("AUDIO_CONSOLE.Soundboard.Notify.MacroFailed"));
    return null;
  }
}

/**
 * Answer a sound dropped on the hotbar. Detached from the hook on purpose — see registerHotbarDrop.
 *
 * Resolved through core's own fromDropData rather than fromUuid, because the two drags that land
 * here carry different halves of a drop payload: a pad sends its `uuid`, a library row sends
 * inline `data` (it has no document to point at). fromDropData reads either, and it is what the
 * canvas drop uses on the same payload — so whatever lands as an ambient sound also lands as a
 * macro.
 * @param {object} data The drag payload.
 * @param {string} slot The hotbar slot that was dropped on.
 * @returns {Promise<void>}
 */
async function assignSoundMacro(data, slot) {
  try {
    const sound = await foundry.documents.PlaylistSound.implementation.fromDropData(data);
    if (!sound) return;
    const result = await macroForSound(sound);
    if (!result) return;
    await game.user.assignHotbarMacro(result.macro, slot);
    ui.notifications.info(game.i18n.format(
      result.created ? "AUDIO_CONSOLE.Soundboard.Notify.MacroCreated" : "AUDIO_CONSOLE.Soundboard.Notify.MacroReused",
      { name: result.macro.name }
    ));
  } catch (err) {
    console.error(`${MODULE_ID} | could not put a sound on the hotbar`, err);
    ui.notifications.error(game.i18n.localize("AUDIO_CONSOLE.Soundboard.Notify.MacroFailed"));
  }
}

/* -------------------------------------------- */
/*  Containers                                  */
/* -------------------------------------------- */

// A playlist, soundboard or ambience as a hotbar macro, which opens its Pop Out window. Unlike a
// sound's macro this one does need the module: the popout is the module's own window, so there is
// nothing core could open in its place. Opening rather than toggling playback is deliberate — a
// hotbar slot shows no on/off state, so a blind toggle on the wrong slot would start or stop music
// with no feedback, and a soundboard has nothing to toggle. The popout shows state and has Play and
// Stop in its header.

/**
 * The container a hotbar drop carries, when it is one with a Pop Out window. Recognised by our
 * kind flag rather than by a drag marker, so the same container dragged out of core's own Playlists
 * sidebar lands as this macro too instead of core's "Display" one, which opens the raw sheet of a
 * document this module manages. Synchronous on purpose: the hook has to answer before core resolves
 * the document. The queue is a container too, but it has no popout, so "Now Playing" is left to core.
 * @param {object} data The drag payload.
 * @returns {Playlist|null}
 */
function hotbarContainerFor(data) {
  if ((data?.type !== "Playlist") || (typeof data.uuid !== "string")) return null;
  const doc = foundry.utils.fromUuidSync(data.uuid);
  return CONTAINER_MACRO_ICONS[containerKindOf(doc)] ? doc : null;
}

/**
 * The macro body. The guard's message is hardcoded English on purpose: it runs exactly when the
 * module, and so its lang file, is not loaded — and without it the macro would fail with a
 * ReferenceError that core reports nowhere the GM can see.
 * @param {Playlist} container
 * @returns {string}
 */
function containerCommandFor(container) {
  return [
    `// Audio Console — opens ${JSON.stringify(container.name)} in its own window.`,
    `if (!globalThis.AudioConsole) return ui.notifications.warn("Audio Console is not active in this world.");`,
    `AudioConsole.Open(${JSON.stringify(container.id)});`
  ].join("\n");
}

/**
 * The macro for a container — the one that already exists for it, or a new one. Reuse is by id, the
 * way a sound's is by path. Nothing deletes or renames it when the container changes: once made,
 * the macro is the GM's, and running it after the container is gone warns (main.js openConsole).
 * @param {Playlist} container
 * @returns {Promise<{macro: Macro, created: boolean}|null>} Null if the macro could not be made.
 */
async function macroForContainer(container) {
  const existing = findMacroForContainer(container.id);
  if (existing) return { macro: existing, created: false };

  const folder = getMacroFolder() ?? await createMacroFolder();
  const macro = await createMacro({
    name: container.name,
    command: containerCommandFor(container),
    img: CONTAINER_MACRO_ICONS[containerKindOf(container)],
    flags: { [FLAGS.CONTAINER_ID]: container.id },
    folder: folder?.id ?? null
  });
  return macro ? { macro, created: true } : null;
}

/**
 * Answer a container dropped on the hotbar. Detached from the hook, as assignSoundMacro is.
 * @param {Playlist} container
 * @param {string} slot The hotbar slot that was dropped on.
 * @returns {Promise<void>}
 */
async function assignContainerMacro(container, slot) {
  try {
    const result = await macroForContainer(container);
    if (!result) return;
    await game.user.assignHotbarMacro(result.macro, slot);
    ui.notifications.info(game.i18n.format(
      result.created ? "AUDIO_CONSOLE.Soundboard.Notify.MacroCreated" : "AUDIO_CONSOLE.Soundboard.Notify.MacroReused",
      { name: result.macro.name }
    ));
  } catch (err) {
    console.error(`${MODULE_ID} | could not put a container on the hotbar`, err);
    ui.notifications.error(game.i18n.localize("AUDIO_CONSOLE.Containers.Notify.MacroFailed"));
  }
}

/**
 * Claim the hotbar drops that carry one of our sounds — a pad or a library row — or one of our
 * containers.
 *
 * The callback has to answer synchronously — returning false is what stops core's own handling,
 * and core would otherwise resolve the payload as the document it says it is and leave a macro
 * that only opens that document's sheet — so the work is started and deliberately not awaited.
 *
 * A sound is recognised by the module id key rather than by `type`, which says "PlaylistSound" so
 * that the same drag lands on the canvas as an ambient sound (apps/console-normal.js). A sound
 * dragged out of core's Playlists sidebar carries no such key and is left to core. A container is
 * recognised by its flag instead (hotbarContainerFor), wherever the drag started.
 *
 * Core refuses a locked bar before it calls this hook (build 369), so the lock needs no check here.
 */
export function registerHotbarDrop() {
  foundry.helpers.Hooks.on("hotbarDrop", (hotbar, data, slot) => {
    if (data?.[MODULE_ID] === SOUND_DRAG_MARKER) {
      assignSoundMacro(data, slot);
      return false;
    }
    const container = hotbarContainerFor(data);
    if (!container) return;
    assignContainerMacro(container, slot);
    return false;
  });
}
