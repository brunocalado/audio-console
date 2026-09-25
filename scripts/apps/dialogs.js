/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { CHANNEL_LABEL_KEYS, DEFAULT_PAD_ICON, LIBRARY_CHANGED_HOOK, LIBRARY_DIR, MAX_PAD_LABEL_LENGTH, MAX_TAG_LENGTH, MIN_RANDOM_WAIT_S, MIN_TAG_LENGTH, MODULE_ID } from "../constants.js";
import { filePickerClass, formatBytes, formatDuration, sanitizeUserTags } from "../helpers.js";
import { probeDuration } from "../audio/durations.js";
import { SKIP_REASONS } from "../library/consolidate.js";
import * as library from "../library/index.js";

// Small DialogV2 wrappers used by the console. Each one returns plain data (or null when the GM
// dismissed it) and touches neither the catalogue nor a document — the caller decides what to do
// with the answer.

const { DialogV2 } = foundry.applications.api;
const { escapeHTML } = foundry.utils;

/**
 * Every dialog in this file wears the console's frame. A DialogV2 renders outside the console's
 * own element, so it inherits nothing from it — the scope class has to be on the dialog frame for
 * the module's tokens and rules to reach the window at all (.claude/rules/ui-patterns.md, "CSS scoping").
 * `themed theme-dark` is core's own convention, and is what makes anything core opens from inside
 * the dialog follow the console rather than the world's theme. Styled by styles/dialogs.css.
 *
 * Safe to share across calls: ApplicationV2 deep-clones every array option while merging
 * (`#mergeApplicationOptions`), so no dialog can push its own classes into this one.
 */
const DIALOG_CLASSES = [MODULE_ID, "ac-dialog", "themed", "theme-dark"];

/**
 * A multi-button DialogV2 never resolves to nothing. Core's `_onSubmit` is
 * `(await button.callback?.()) ?? button.action`, so a cancel callback returning `null` resolves
 * to the string `"cancel"` — truthy, and indistinguishable from a real answer to a caller testing
 * `if (!choice)`. Measured live in v14.365 against confirmContainerDelete, where it made Cancel
 * delete the playlist.
 *
 * So every multi-button helper below funnels its result through this: only an answer the caller
 * actually offered gets through, and dismissing the window (which resolves `null`) and pressing
 * Cancel both come back as `null`.
 *
 * @param {*} result What DialogV2.wait resolved with.
 * @param {string[]} answers The meaningful answers.
 * @returns {string|null}
 */
function chosen(result, answers) {
  return answers.includes(result) ? result : null;
}

/** @param {string} key @param {object} [data] @returns {string} */
function t(key, data) {
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}

/**
 * The channel selector: a mutually-exclusive radio pair, on both paths that put files into the
 * library (one file, or a whole folder). It decides which of the user's mixer sliders governs the
 * sound, so it is a setting rather than a tag — see constants.js CHANNELS. Native radio inputs are
 * the exclusivity mechanism, and the stylesheet derives the highlight from the radio state alone
 * (styles/dialogs.css .ac-channel-chip): a rendered `.active` class cannot follow a click.
 * @param {string} selected
 * @returns {string}
 */
function channelField(selected) {
  const options = Object.entries(CHANNEL_LABEL_KEYS).map(([value, label]) => `
    <label class="ac-channel-chip">
      <input type="radio" name="channel" value="${value}"${value === selected ? " checked" : ""}>
      <span inert>${escapeHTML(t(label))}</span>
    </label>`);
  return `
    <div class="form-group">
      <label>${escapeHTML(t("AUDIO_CONSOLE.Library.Channel.Label"))}</label>
      <div class="form-fields ac-channel-toggle" role="radiogroup">${options.join("")}</div>
      <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Library.Channel.Hint"))}</p>
    </div>`;
}

/**
 * A number field's value, or a fallback when it was left blank or holds nothing numeric — a blank
 * `<input type="number">` submits "", and `Number("")` is 0, which `??` never catches.
 * @param {*} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function numberOr(raw, fallback, min, max) {
  const value = (raw === "" || raw === null || raw === undefined) ? NaN : Number(raw);
  return Math.clamp(Number.isFinite(value) ? value : fallback, min, max);
}

/**
 * A slider's position as a percentage. The position, not the gain — a range in this module is
 * always AudioHelper's perceptual input value, so 50% means "the fader is halfway", which is what
 * a GM reads it as.
 * @param {number|string} input A 0..1 slider value.
 * @returns {string}
 */
function percentLabel(input) {
  return `${Math.round(Number(input) * 100)}%`;
}

/**
 * The random-interval fields as a GM reads them: the shortest and the longest wait, in seconds.
 *
 * EntryFlags stores the same range as a centre and a spread (interval × (1 ± variance)), and so do
 * the public API and every pack already built against it — so the pair is converted here, at the
 * one place a person types it, rather than migrated. "0.5" was a number a GM had to do arithmetic
 * on; "30 to 90" is not. Equal values are a fixed interval (variance 0).
 *
 * Shown to one decimal because a stored centre and spread need not land on whole seconds (45 ± 50%
 * is 22.5–67.5); rounding to integers would quietly shift the range every time the dialog was
 * saved unchanged. `step="any"` for the same reason — a value the dialog itself filled in must not
 * fail the form's own validation.
 * @param {string} idPrefix
 * @param {{interval: number, variance: number}} random
 * @returns {string}
 */
function randomRangeFields(idPrefix, { interval, variance }) {
  const round = value => Math.round(value * 10) / 10;
  const min = Math.max(round(interval * (1 - variance)), MIN_RANDOM_WAIT_S);
  const max = round(interval * (1 + variance));
  return `
    <div class="form-group">
      <label for="${idPrefix}-min">${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.MinLabel"))}</label>
      <div class="form-fields"><input id="${idPrefix}-min" type="number" name="min" min="${MIN_RANDOM_WAIT_S}" step="any" value="${min}"></div>
    </div>
    <div class="form-group">
      <label for="${idPrefix}-max">${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.MaxLabel"))}</label>
      <div class="form-fields"><input id="${idPrefix}-max" type="number" name="max" min="${MIN_RANDOM_WAIT_S}" step="any" value="${max}"></div>
      <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.RangeHint"))}</p>
    </div>`;
}

/**
 * randomRangeFields read back into the stored centre and spread. A reversed pair is taken as the
 * range it obviously means rather than rejected.
 * @param {object} result The dialog's form data.
 * @returns {{interval: number, variance: number}}
 */
function readRandomRange(result) {
  const a = numberOr(result.min, 30, MIN_RANDOM_WAIT_S, Infinity);
  const b = numberOr(result.max, 90, MIN_RANDOM_WAIT_S, Infinity);
  const [min, max] = a <= b ? [a, b] : [b, a];
  return { interval: (min + max) / 2, variance: (max - min) / (max + min) };
}

/**
 * Fill a dialog's `[data-duration]` with how long the file runs. Filled after render because the
 * read is async; durations.js caches it, so a file already measured by a playlist row shows at
 * once. It is here so a GM choosing a random range can see what the wait is added to
 * (random-scheduler.js counts it from the end of the sound).
 * @param {HTMLElement} root
 * @param {string} path
 */
function bindDuration(root, path) {
  const target = root.querySelector("[data-duration]");
  if (!target || !path) return;
  probeDuration(path).then(seconds => {
    target.textContent = (seconds === null) ? "–" : formatDuration(seconds);
  });
}

/**
 * How an entry plays, as three chips of which exactly one is lit — Play Once, Loop, or Random
 * Interval — for both the pad config and the ambience layer's. The channel selector's radio chips
 * (channelField), so the exclusivity is the browser's and the highlight follows the checked input
 * alone.
 *
 * One choice rather than a Loop switch beside a "fire automatically" one: two switches allowed
 * both at once, which means nothing useful — the first automatic fire loops forever and the
 * scheduler skips every later one because the entry is still playing. The choice still lands on
 * the same two stored fields (`repeat` and random.enabled), so nothing saved needs migrating; an
 * entry saved with both on opens as Random Interval, the last thing its GM asked for.
 * @param {boolean} loop
 * @param {boolean} random
 * @returns {string}
 */
function playbackField(loop, random) {
  const mode = random ? "random" : (loop ? "loop" : "once");
  const chips = ["once", "loop", "random"].map(value => `
    <label class="ac-channel-chip">
      <input type="radio" name="mode" value="${value}"${value === mode ? " checked" : ""}>
      <span inert>${escapeHTML(t(`AUDIO_CONSOLE.Soundboard.Dialogs.Mode.${value}`))}</span>
    </label>`).join("");
  return `
    <div class="form-group">
      <label>${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.ModeLabel"))}</label>
      <div class="form-fields ac-channel-toggle" role="radiogroup" data-playback-mode>${chips}</div>
    </div>`;
}

/**
 * Show a dialog's `[data-random-fields]` only while Random Interval is chosen — the range means
 * nothing in the other two modes. Hidden fields still submit, which keeps a range a GM set up and
 * then switched away from.
 * @param {DialogV2} dialog
 */
function bindPlaybackMode(dialog) {
  const fields = dialog.element.querySelector("[data-random-fields]");
  dialog.element.querySelector("[data-playback-mode]")?.addEventListener("change", event => {
    fields.hidden = event.target.value !== "random";
    dialog.setPosition({ height: "auto" });
  });
}

/**
 * The volume slider both entry dialogs carry. Shown and read back through the same input<->gain
 * mapping the transport slider uses (AudioHelper.volumeToInput/inputToVolume), so a value set here
 * feels the same as one dragged live — the slider position is never the raw gain.
 * @param {string} idPrefix
 * @param {number} volume
 * @returns {string}
 */
function volumeField(idPrefix, volume) {
  const input = foundry.audio.AudioHelper.volumeToInput(volume ?? 0.8);
  return `
    <div class="form-group">
      <label for="${idPrefix}-volume">${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.VolumeLabel"))}</label>
      <div class="form-fields ac-slider-field">
        <input id="${idPrefix}-volume" type="range" name="volume" min="0" max="1" step="0.01" value="${input}">
        <output class="ac-slider-value" for="${idPrefix}-volume">${percentLabel(input)}</output>
      </div>
    </div>`;
}

/**
 * Keeps every `<output class="ac-slider-value">` in a dialog showing its slider's position while
 * it is dragged. One delegated listener on the form rather than one per slider, so a dialog that
 * grows a second slider needs no extra wiring.
 * @param {HTMLElement} root The dialog element.
 */
function bindSliderReadout(root) {
  root.addEventListener("input", event => {
    const slider = event.target;
    if (slider.type !== "range") return;
    const out = root.querySelector(`output.ac-slider-value[for="${slider.id}"]`);
    if (out) out.textContent = percentLabel(slider.value);
  });
}

/**
 * Wires a dialog's image field: Browse opens core's file picker, and the preview follows whatever
 * lands in the path input — typed, pasted or picked.
 * @param {HTMLElement} root The dialog element.
 */
function bindIconPicker(root) {
  const input = root.querySelector("[data-icon-path]");
  const preview = root.querySelector("[data-icon-preview]");
  const browse = root.querySelector("[data-icon-browse]");
  if (!input) return;

  const sync = () => { if (preview) preview.src = input.value || DEFAULT_PAD_ICON; };
  input.addEventListener("change", sync);

  // Clearing is a real answer, not an empty field to be ignored: it puts the pad back on the
  // module's default icon (promptPadConfig returns null for a blank path), which is why the
  // preview goes to DEFAULT_PAD_ICON rather than to nothing.
  root.querySelector("[data-icon-clear]")?.addEventListener("click", () => {
    input.value = "";
    sync();
  });

  browse?.addEventListener("click", () => {
    new (filePickerClass())({
      type: "image",
      current: input.value,
      callback: path => { input.value = path; sync(); }
    }).browse();
  });
}

/**
 * The file a library row points at.
 *
 * Read-only when a file has just been picked — it is the answer to the question the picker asked a
 * second ago, and there is nothing to correct. Editable when an existing row is open, because a
 * file that moved on disk is otherwise a row that can only be deleted and rebuilt from scratch.
 * @param {string} path
 * @param {boolean} editable
 * @returns {string}
 */
function pathField(path, editable) {
  if (!editable) return `<p class="hint">${escapeHTML(path)}</p>`;
  return `
    <div class="form-group">
      <label for="ac-path">${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.PathLabel"))}</label>
      <div class="form-fields ac-path-field">
        <input id="ac-path" type="text" name="path" value="${escapeHTML(path)}" data-audio-path>
        <button type="button" class="ac-button" data-audio-browse>
          <i class="fa-solid fa-folder-open" inert></i>
          <span inert>${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.PathBrowse"))}</span>
        </button>
      </div>
      <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.PathHint"))}</p>
    </div>`;
}

/**
 * Browse for the audio file the row should point at.
 * @param {HTMLElement} root The dialog element.
 */
function bindAudioPicker(root) {
  const input = root.querySelector("[data-audio-path]");
  if (!input) return;
  root.querySelector("[data-audio-browse]")?.addEventListener("click", () => {
    new (filePickerClass())({
      type: "audio",
      current: input.value,
      callback: path => { input.value = path; }
    }).browse();
  });
}

/**
 * A two-tab body for the dialogs that register or edit a library row: the fields on one tab, the
 * tag picker on the other.
 *
 * Written as plain markup rather than through ApplicationV2's tab machinery. A DialogV2's content
 * is a string — there is no part context for a `tabs` group to hang off — and what a tab actually
 * needs here is one class on a nav button and one on a panel, which is less code than adapting the
 * framework would be. The panels stay in the form whether they are showing or not, so a hidden
 * tab's inputs are still submitted.
 * @param {{id: string, label: string, icon: string, content: string}[]} tabs The first one opens.
 * @returns {string}
 */
function tabbedBody(tabs) {
  const nav = tabs.map((tab, index) => `
    <button type="button" role="tab" class="ac-dialog-tab${index ? "" : " active"}" data-dialog-tab="${tab.id}"
            aria-selected="${index ? "false" : "true"}" aria-controls="ac-dialog-panel-${tab.id}">
      <i class="fa-solid ${tab.icon}" inert></i>
      <span inert>${escapeHTML(tab.label)}</span>
    </button>`).join("");
  const panels = tabs.map((tab, index) => `
    <div role="tabpanel" class="ac-dialog-panel${index ? "" : " active"}" id="ac-dialog-panel-${tab.id}"
         data-dialog-panel="${tab.id}">${tab.content}</div>`).join("");
  return `<nav class="ac-dialog-tabs" role="tablist">${nav}</nav>${panels}`;
}

/**
 * Makes the nav built by tabbedBody() switch panels. One delegated listener on the nav rather than
 * one per button, so a dialog that grows a third tab needs nothing extra here.
 * @param {HTMLElement} root The dialog element.
 */
function bindDialogTabs(root) {
  const nav = root.querySelector(".ac-dialog-tabs");
  if (!nav) return;
  nav.addEventListener("click", event => {
    const button = event.target.closest("[data-dialog-tab]");
    if (!button) return;
    for (const tab of nav.querySelectorAll("[data-dialog-tab]")) {
      const active = tab === button;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    for (const panel of root.querySelectorAll("[data-dialog-panel]")) {
      panel.classList.toggle("active", panel.dataset.dialogPanel === button.dataset.dialogTab);
    }
  });
}

/**
 * One tag, as something to click. Same `.ac-tag` chip the console's filter panel draws, and
 * `.active` means the same thing in both: this tag is on.
 * @param {string} tag
 * @param {boolean} active
 * @returns {string}
 */
function tagChip(tag, active) {
  return `<button type="button" class="ac-tag${active ? " active" : ""}" data-tag-toggle data-tag="${escapeHTML(tag)}"
          aria-pressed="${active}"><span inert>${escapeHTML(tag)}</span></button>`;
}

/**
 * The vocabulary as chips, with the row's own tags lit. A tag the row carries but the vocabulary
 * somehow does not know is still listed, so a hand-edited library.json stays editable rather than
 * quietly losing tags.
 * @param {Set<string>} active
 * @returns {string}
 */
function tagCloudChips(active) {
  const known = [...new Set([...library.getTagVocabulary().keys(), ...active])].sort((a, b) => a.localeCompare(b));
  return known.map(tag => tagChip(tag, active.has(tag))).join("")
    || `<span class="ac-tags-empty" data-tag-empty>${escapeHTML(t("AUDIO_CONSOLE.Library.Tags.None"))}</span>`;
}

/**
 * The tag tab: the vocabulary as chips, plus a field for a word that is not in it yet.
 *
 * This replaced a comma-separated text field. Typing "combat, tavern" into a box is how a
 * vocabulary grows three spellings of the same tag — with chips the tag that exists is always one
 * click away and only a genuinely new one costs any typing.
 *
 * The answer leaves through a hidden input rather than through the chips, because DialogV2 reads
 * the form and a `.active` class is not form data. It stays comma-joined so the callers keep
 * parsing the field exactly as they did.
 * @param {string[]} selected Tags to start with, for a row being edited.
 * @returns {string}
 */
function tagPickerField(selected) {
  const active = new Set(selected);
  // Manage Tags shares the "add a tag" row: curating the vocabulary — renaming, deleting, adding
  // a tag without applying it — is the one thing this tab deliberately cannot do, so the shortcut
  // to the window that can sits beside it. The separator is what says Add acts on this row while
  // Manage Tags acts on the library.
  return `
    <div class="ac-tag-dialog">
      <input type="hidden" name="tags" value="${escapeHTML([...active].join(","))}" data-tag-value>
      <div class="ac-tag-cloud" role="group" aria-label="${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.TagsCloudLabel"))}" data-tag-cloud>
        ${tagCloudChips(active)}
      </div>
      <div class="ac-tag-add">
        <input type="text" data-new-tag maxlength="${MAX_TAG_LENGTH}" autocomplete="off"
               placeholder="${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.TagsAddPlaceholder"))}"
               aria-label="${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.TagsAddLabel"))}">
        <button type="button" class="ac-button" data-add-tag>
          <i class="fa-solid fa-plus" inert></i>
          <span inert>${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.TagsAddSubmit"))}</span>
        </button>
        <span class="ac-sep" aria-hidden="true"></span>
        <button type="button" class="ac-button ac-button-quiet" data-open-tag-manager>
          <i class="fa-solid fa-pen-to-square" inert></i>
          <span inert>${escapeHTML(t("AUDIO_CONSOLE.TagManager.Open"))}</span>
        </button>
      </div>
      <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.TagsCloudHint", { min: MIN_TAG_LENGTH, max: MAX_TAG_LENGTH }))}</p>
    </div>`;
}

/**
 * Wires the tag tab: chips toggle, and the field mints a chip for a word the vocabulary does not
 * have yet. Nothing here touches the catalogue — a new tag joins the vocabulary only when the
 * caller saves the row, so a dismissed dialog leaves no trace.
 * @param {HTMLElement} root The dialog element.
 * @param {foundry.applications.api.DialogV2} dialog The dialog itself, for the lifetime of the
 *   library subscription below.
 */
function bindTagPicker(root, dialog) {
  const hidden = root.querySelector("[data-tag-value]");
  const cloud = root.querySelector("[data-tag-cloud]");
  const field = root.querySelector("[data-new-tag]");
  if (!hidden || !cloud) return;

  // Read back off the chips rather than maintained alongside them: two records of the same answer
  // is how one of them ends up stale.
  const sync = () => {
    hidden.value = [...cloud.querySelectorAll("[data-tag-toggle].active")].map(chip => chip.dataset.tag).join(",");
  };

  // The chips are a snapshot of the vocabulary taken when the dialog opened. Manage Tags beside
  // them opens a window that changes that vocabulary while this stays open, so a tag coined there
  // has to appear here or the button reads as broken. The lit set is the GM's draft and is kept
  // as-is; the debounced hook (library/index.js) means a burst of edits is one redraw.
  const repaint = () => {
    cloud.innerHTML = tagCloudChips(new Set(hidden.value.split(",").filter(Boolean)));
  };
  const hookId = foundry.helpers.Hooks.on(LIBRARY_CHANGED_HOOK, repaint);
  dialog.addEventListener("close", () => foundry.helpers.Hooks.off(LIBRARY_CHANGED_HOOK, hookId), { once: true });

  root.querySelector("[data-open-tag-manager]")?.addEventListener("click", async () => {
    // Lazily imported like the console does: most sessions never open it.
    const { AudioConsoleTagManager } = await import("./tag-manager.js");
    AudioConsoleTagManager.open();
  });

  cloud.addEventListener("click", event => {
    const chip = event.target.closest("[data-tag-toggle]");
    if (!chip) return;
    chip.setAttribute("aria-pressed", String(chip.classList.toggle("active")));
    sync();
  });

  const addTyped = () => {
    const tag = sanitizeUserTags([field.value])[0];
    field.value = "";
    if (!tag) {
      // Almost always the length floor — the field caps the maximum itself, so the only other way
      // to normalise to nothing is typing punctuation alone.
      ui.notifications.warn(game.i18n.format("AUDIO_CONSOLE.TagManager.Notify.Invalid", { min: MIN_TAG_LENGTH, max: MAX_TAG_LENGTH }));
      return;
    }
    const existing = cloud.querySelector(`[data-tag-toggle][data-tag="${CSS.escape(tag)}"]`);
    if (existing) {
      existing.classList.add("active");
      existing.setAttribute("aria-pressed", "true");
    } else {
      cloud.querySelector("[data-tag-empty]")?.remove();
      cloud.insertAdjacentHTML("beforeend", tagChip(tag, true));
    }
    sync();
  };

  root.querySelector("[data-add-tag]")?.addEventListener("click", addTyped);
  field?.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    // Enter in this field means "add this tag". Left alone it would submit the dialog instead —
    // the field sits inside DialogV2's form, whose implicit submission is the OK button.
    event.preventDefault();
    addTyped();
  });
}

/* -------------------------------------------- */

/**
 * Name, channel and tags for one library row — registering a file for the first time and editing
 * one afterwards are the same three answers, so they are the same dialog. The two exported
 * wrappers below differ only in what the window and its submit button are called.
 *
 * The path is the catalogue's key (library/index.js), so changing it is a rekey rather than a
 * field write — `pathEditable` is what decides whether this dialog offers that at all, and the
 * returned `path` is only meaningful when it does.
 * @param {{path: string, name: string, channel: string, tags: string[], pathEditable: boolean,
 *   title: string, windowIcon: string, submitLabel: string, submitIcon: string}} options
 * @returns {Promise<{name: string, path: string, channel: string, tags: string[]}|null>}
 */
async function entryDialog({ path, name, channel, tags, pathEditable, title, windowIcon, submitLabel, submitIcon }) {
  const result = await DialogV2.input({
    window: { title, icon: windowIcon },
    classes: DIALOG_CLASSES,
    position: { width: 480 },
    content: `
      <div class="ac-channel-dialog">
        ${tabbedBody([
          {
            id: "details",
            label: t("AUDIO_CONSOLE.Library.Dialogs.DetailsTab"),
            icon: "fa-file-audio",
            content: `
              <div class="form-group">
                <label for="ac-name">${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.NameLabel"))}</label>
                <div class="form-fields"><input id="ac-name" type="text" name="name" value="${escapeHTML(name)}" autofocus></div>
              </div>
              ${pathField(path, pathEditable)}
              ${channelField(channel)}`
          },
          {
            id: "tags",
            label: t("AUDIO_CONSOLE.Library.Dialogs.TagsLabel"),
            icon: "fa-tags",
            content: tagPickerField(tags)
          }
        ])}
      </div>`,
    ok: { label: submitLabel, icon: submitIcon },
    render: (event, dialog) => {
      bindDialogTabs(dialog.element);
      bindTagPicker(dialog.element, dialog);
      bindAudioPicker(dialog.element);
    }
  });
  if (!result) return null;
  return {
    name: String(result.name ?? "").trim(),
    // Falls back to the path handed in, so a caller that did not offer the field still gets one
    // rather than undefined.
    path: String(result.path ?? path).trim(),
    channel: result.channel,
    tags: sanitizeUserTags(String(result.tags ?? "").split(","))
  };
}

/**
 * A file the GM just picked, on its way into the catalogue.
 * @param {{path: string, name: string, channel: string, tags?: string[]}} suggestion
 * @returns {Promise<{name: string, path: string, channel: string, tags: string[]}|null>}
 */
export async function promptNewEntry({ path, name, channel, tags = [] }) {
  return entryDialog({
    path, name, channel, tags,
    pathEditable: false,
    title: t("AUDIO_CONSOLE.Library.Dialogs.AddTitle"),
    windowIcon: "fa-solid fa-file-audio",
    submitLabel: t("AUDIO_CONSOLE.Library.Dialogs.AddSubmit"),
    submitIcon: "fa-solid fa-plus"
  });
}

/**
 * A row already in the catalogue, opened to be changed. Same dialog as adding one, the tags tab
 * included — it is the only place a row's tags are edited.
 * @param {{path: string, name: string, channel: string, tags: string[]}} entry
 * @returns {Promise<{name: string, path: string, channel: string, tags: string[]}|null>}
 */
export async function promptEditEntry({ path, name, channel, tags }) {
  return entryDialog({
    path, name, channel, tags,
    pathEditable: true,
    title: t("AUDIO_CONSOLE.Library.Dialogs.EditTitle"),
    windowIcon: "fa-solid fa-pen-to-square",
    submitLabel: t("AUDIO_CONSOLE.Library.Dialogs.EditSubmit"),
    submitIcon: "fa-solid fa-check"
  });
}

/* -------------------------------------------- */

/**
 * Deleting a tag from the vocabulary. Confirmed by count, because the rows that lose it are not on
 * screen in the tag manager — and unlike removing a tag from one track, this cannot be undone by
 * retagging the one thing you were looking at.
 * @param {{tag: string, count: number}} options
 * @returns {Promise<boolean>}
 */
export async function confirmDeleteTag({ tag, count }) {
  return DialogV2.confirm({
    window: { title: t("AUDIO_CONSOLE.TagManager.Dialogs.DeleteTitle"), icon: "fa-solid fa-tag" },
    classes: DIALOG_CLASSES,
    position: { width: 480 },
    content: `
      <p>${escapeHTML(t("AUDIO_CONSOLE.TagManager.Dialogs.DeleteQuestion", { tag, count }))}</p>
      <p class="notification warning">${escapeHTML(t("AUDIO_CONSOLE.TagManager.Dialogs.DeleteNotice"))}</p>`,
    yes: { label: t("AUDIO_CONSOLE.TagManager.Actions.Delete"), icon: "fa-solid fa-trash" }
  });
}

/* -------------------------------------------- */

/**
 * "Delete" next to a music file reads as "delete the file", so the confirmation says in full what
 * is and is not removed.
 * @param {{name: string, path: string}} entry
 * @returns {Promise<boolean>}
 */
export async function confirmRemoveEntry(entry) {
  return DialogV2.confirm({
    window: { title: t("AUDIO_CONSOLE.Library.Dialogs.RemoveTitle"), icon: "fa-solid fa-xmark" },
    classes: DIALOG_CLASSES,
    position: { width: 480 },
    content: `
      <p>${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.RemoveQuestion", { name: entry.name }))}</p>
      <p class="hint">${escapeHTML(entry.path)}</p>
      <p class="notification warning">${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.RemoveNotice"))}</p>`,
    yes: { label: t("AUDIO_CONSOLE.Library.Actions.Remove"), icon: "fa-solid fa-trash" }
  });
}

/**
 * The folder-level counterpart of confirmRemoveEntry: every catalogue row under this folder
 * (subfolders included), named by count since listing potentially thousands of rows the way
 * confirmScanResults once tried to is exactly the mistake that dialog got removed for.
 * @param {{name: string, count: number}} folder
 * @returns {Promise<boolean>}
 */
export async function confirmRemoveFolder({ name, count }) {
  return DialogV2.confirm({
    window: { title: t("AUDIO_CONSOLE.Library.Dialogs.RemoveFolderTitle"), icon: "fa-solid fa-folder-minus" },
    classes: DIALOG_CLASSES,
    position: { width: 480 },
    content: `
      <p>${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.RemoveFolderQuestion", { name, count }))}</p>
      <p class="notification warning">${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.RemoveNotice"))}</p>`,
    yes: { label: t("AUDIO_CONSOLE.Library.Actions.Remove"), icon: "fa-solid fa-trash" }
  });
}

/**
 * Emptying the Now Playing queue. Confirmed where removing one track is not: the running order is
 * built one track at a time and nothing rebuilds it, so this is the only control in that section
 * a GM can lose work to.
 * @param {number} count How many tracks are in the queue.
 * @returns {Promise<boolean>}
 */
export async function confirmClearQueue(count) {
  return DialogV2.confirm({
    window: { title: t("AUDIO_CONSOLE.Queue.Dialogs.ClearTitle"), icon: "fa-solid fa-list-check" },
    classes: DIALOG_CLASSES,
    position: { width: 480 },
    content: `
      <p>${escapeHTML(t("AUDIO_CONSOLE.Queue.Dialogs.ClearQuestion", { count }))}</p>
      <p class="notification warning">${escapeHTML(t("AUDIO_CONSOLE.Queue.Dialogs.ClearNotice"))}</p>`,
    yes: { label: t("AUDIO_CONSOLE.Queue.Actions.Clear"), icon: "fa-solid fa-trash" }
  });
}

/* -------------------------------------------- */

/**
 * Scan options, asked before browsing runs — recursion has to be decided up front because it
 * changes what the scan even looks at. One shared channel/tags choice applies to every file found;
 * there is no per-file choice for a folder scan, which is the whole point of scanning a folder
 * that holds one kind of audio. Same two tabs as the add dialog, and for the same reason: tags are
 * picked from the vocabulary rather than typed as a comma-separated line.
 * @param {{dir: string, channel: string}} options
 * @returns {Promise<{recurse: boolean, channel: string, tags: string[]}|null>}
 */
export async function promptScanOptions({ dir, channel }) {
  const result = await DialogV2.input({
    window: { title: t("AUDIO_CONSOLE.Library.Dialogs.ScanTitle"), icon: "fa-solid fa-folder-open" },
    classes: DIALOG_CLASSES,
    position: { width: 480 },
    content: `
      <div class="ac-channel-dialog">
        ${tabbedBody([
          {
            id: "details",
            label: t("AUDIO_CONSOLE.Library.Dialogs.DetailsTab"),
            icon: "fa-folder-open",
            content: `
              <p>${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.ScanIntro"))}</p>
              <p class="hint">${escapeHTML(dir)}</p>
              <div class="ac-wide-labels">
                <div class="form-group">
                  <label for="ac-recurse">${escapeHTML(t("AUDIO_CONSOLE.Library.Dialogs.RecurseLabel"))}</label>
                  <div class="form-fields"><input id="ac-recurse" type="checkbox" name="recurse" checked></div>
                </div>
                ${channelField(channel)}
              </div>`
          },
          {
            id: "tags",
            label: t("AUDIO_CONSOLE.Library.Dialogs.TagsLabel"),
            icon: "fa-tags",
            content: tagPickerField([])
          }
        ])}
      </div>`,
    ok: { label: t("AUDIO_CONSOLE.Library.Dialogs.ScanSubmit"), icon: "fa-solid fa-magnifying-glass" },
    render: (event, dialog) => {
      bindDialogTabs(dialog.element);
      bindTagPicker(dialog.element, dialog);
    }
  });
  if (!result) return null;
  return {
    recurse: !!result.recurse,
    channel: result.channel,
    tags: sanitizeUserTags(String(result.tags ?? "").split(","))
  };
}

/* -------------------------------------------- */
/*  Playlists                                    */
/* -------------------------------------------- */

/**
 * Name a container, for both creation and rename — one dialog, two callers. Not `required`: an
 * empty submit is a valid answer (the caller falls back to an auto-generated name on create), and
 * a `required` field previously made the OK button appear to do nothing when left blank — the
 * browser silently rejected the submit rather than resolving the dialog.
 * @param {{title: string, submitLabel: string, name?: string}} options
 * @returns {Promise<string|null>} The trimmed name ("" if submitted blank), or null if dismissed.
 */
export async function promptContainerName({ title, submitLabel, name = "" }) {
  const result = await DialogV2.input({
    window: { title, icon: "fa-solid fa-list-ol" },
    classes: DIALOG_CLASSES,
    position: { width: 420 },
    content: `
      <div class="form-group">
        <label for="ac-container-name">${escapeHTML(t("AUDIO_CONSOLE.Playlists.Dialogs.NameLabel"))}</label>
        <div class="form-fields">
          <input id="ac-container-name" type="text" name="name" value="${escapeHTML(name)}" autofocus>
        </div>
      </div>`,
    ok: { label: submitLabel, icon: "fa-solid fa-check" }
  });
  if (!result) return null;
  return String(result.name ?? "").trim();
}

/**
 * The three-way choice in this module's deletion semantics — coherent only for containers, never
 * for an entry or a library row. Each option's consequence is spelled out rather than left to the
 * button label alone, the same rule confirmRemoveEntry follows.
 *
 * Both options are Document writes and nothing else — `releaseContainers` clears the folder and
 * the flag scope, `deleteContainers` deletes the Playlist. A module cannot move or delete a file
 * on disk without the GM going through a FilePicker, and this one never tries. The wording used
 * to borrow filesystem verbs ("moves it out of the module folder", "gone entirely, tracks
 * included") for what are folder and embedded-document operations, so it read as a promise the
 * module has no way to keep; the notice line now says outright which of the two it is, the same
 * way confirmRemoveEntry and confirmClearQueue do.
 * @param {Playlist} container
 * @returns {Promise<"release"|"delete"|null>}
 */
export async function confirmContainerDelete(container) {
  const result = await DialogV2.wait({
    window: { title: t("AUDIO_CONSOLE.Playlists.Dialogs.DeleteTitle", { name: container.name }), icon: "fa-solid fa-trash" },
    classes: DIALOG_CLASSES,
    position: { width: 480 },
    content: `
      <p>${escapeHTML(t("AUDIO_CONSOLE.Playlists.Dialogs.DeleteQuestion", { name: container.name }))}</p>
      <p class="hint"><strong>${escapeHTML(t("AUDIO_CONSOLE.Playlists.Dialogs.DeleteRelease"))}:</strong> ${escapeHTML(t("AUDIO_CONSOLE.Playlists.Dialogs.DeleteReleaseHint"))}</p>
      <p class="hint"><strong>${escapeHTML(t("AUDIO_CONSOLE.Playlists.Dialogs.DeletePermanent"))}:</strong> ${escapeHTML(t("AUDIO_CONSOLE.Playlists.Dialogs.DeletePermanentHint"))}</p>
      <p class="notification warning">${escapeHTML(t("AUDIO_CONSOLE.Playlists.Dialogs.DeleteNotice"))}</p>`,
    buttons: [
      {
        action: "release",
        label: t("AUDIO_CONSOLE.Playlists.Dialogs.DeleteRelease"),
        icon: "fa-solid fa-arrow-right-from-bracket",
        callback: () => "release"
      },
      {
        action: "delete",
        label: t("AUDIO_CONSOLE.Playlists.Dialogs.DeletePermanent"),
        icon: "fa-solid fa-trash",
        callback: () => "delete"
      },
      {
        action: "cancel",
        label: t("AUDIO_CONSOLE.Playlists.Dialogs.DeleteCancel"),
        icon: "fa-solid fa-xmark",
        callback: () => null
      }
    ]
  });
  return chosen(result, ["release", "delete"]);
}

/* -------------------------------------------- */
/*  Soundboard                                   */
/* -------------------------------------------- */

/**
 * A soundboard pad's config: its name, how it plays (playbackField), volume, an optional accent
 * colour, and its icon.
 *
 * It is also where a pad is removed from its board. The pad face used to carry that as a corner
 * button, one stray click from wiping the pad's icon, colour and timing; here it takes opening the
 * config first, and the trash sits beside Save rather than in a row of its own. The dialog resolves
 * with the string "remove" for it, so the caller tells the two apart without a second callback.
 *
 * @param {{name: string, path: string, label: string|null, volume: number, loop: boolean,
 *   color: string|null, random: {enabled: boolean, interval: number, variance: number}}} pad
 * @returns {Promise<{label: string|null, volume: number, loop: boolean, color: string|null,
 *   random: {enabled: boolean, interval: number, variance: number}}|"remove"|null>}
 */
export async function promptPadConfig({ name, path, label, volume, loop, color, icon, random }) {
  const iconValue = icon || DEFAULT_PAD_ICON;
  const result = await DialogV2.input({
    window: { title: t("AUDIO_CONSOLE.Soundboard.Dialogs.ConfigTitle", { name }), icon: "fa-solid fa-gear" },
    classes: DIALOG_CLASSES,
    position: { width: 480 },
    // Two tabs: how the pad sounds, and how it looks. The sound tab opens first — it is what a GM
    // reaches for mid-session; name, colour and icon are set up once.
    content: `
      <div class="ac-wide-labels">
      ${tabbedBody([
        {
          id: "sound",
          label: t("AUDIO_CONSOLE.Soundboard.Dialogs.SoundTab"),
          icon: "fa-volume-high",
          content: `
            <div class="form-group">
              <label>${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.DurationLabel"))}</label>
              <div class="form-fields"><span class="ac-duration-value" data-duration>…</span></div>
            </div>
            ${volumeField("ac-pad", volume)}
            ${playbackField(loop, random.enabled)}
            <fieldset data-random-fields${random.enabled ? "" : " hidden"}>
              <legend>${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.RandomLegend"))}</legend>
              ${randomRangeFields("ac-pad", random)}
            </fieldset>`
        },
        {
          id: "appearance",
          label: t("AUDIO_CONSOLE.Soundboard.Dialogs.AppearanceTab"),
          icon: "fa-palette",
          content: `
            <div class="form-group">
              <label for="ac-pad-label">${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.LabelLabel"))}</label>
              <div class="form-fields">
                <input id="ac-pad-label" type="text" name="label" value="${escapeHTML(label ?? "")}"
                       maxlength="${MAX_PAD_LABEL_LENGTH}" placeholder="${escapeHTML(name)}" autocomplete="off">
              </div>
            </div>
            <div class="form-group">
              <label for="ac-pad-color-enabled">${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.ColorLabel"))}</label>
              <div class="form-fields">
                <input id="ac-pad-color-enabled" type="checkbox" name="colorEnabled"${color ? " checked" : ""}>
                <input id="ac-pad-color" type="color" name="color" value="${color ?? "#d4af37"}">
              </div>
            </div>
            <div class="form-group">
              <label for="ac-pad-icon">${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.IconLabel"))}</label>
              <div class="form-fields ac-icon-field">
                <img class="ac-icon-preview" src="${escapeHTML(iconValue)}" alt="" data-icon-preview>
                <input id="ac-pad-icon" type="text" name="icon" value="${escapeHTML(iconValue)}" data-icon-path>
                <button type="button" class="ac-button" data-icon-browse>
                  <i class="fa-solid fa-file-image" inert></i>
                  <span inert>${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.IconBrowse"))}</span>
                </button>
                <button type="button" class="ac-row-action" data-icon-clear
                        aria-label="${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.IconClear"))}"
                        data-tooltip="${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.IconClear"))}">
                  <i class="fa-solid fa-trash" inert></i>
                </button>
              </div>
            </div>`
        }
      ])}
      </div>`,
    ok: { label: t("AUDIO_CONSOLE.Soundboard.Dialogs.ConfigSubmit"), icon: "fa-solid fa-check" },
    // Labelled, unlike the module's other destructive controls (.claude/rules/ui-patterns.md
    // says icon only): beside a full-width Save, a bare trash square read as a stray control
    // rather than as the other of two answers. `default` stays with Save, so Enter in a field
    // never removes the pad.
    buttons: [{
      action: "remove",
      label: "AUDIO_CONSOLE.Soundboard.Dialogs.Remove",
      icon: "fa-solid fa-trash",
      callback: () => "remove"
    }],
    render: (event, dialog) => {
      bindSliderReadout(dialog.element);
      bindIconPicker(dialog.element);
      bindDuration(dialog.element, path);
      bindDialogTabs(dialog.element);
      bindPlaybackMode(dialog);
    }
  });
  if (!result) return null;
  if (result === "remove") return result;
  return {
    // "" when the field was cleared, which is the GM asking for the track's own name back — null,
    // for the same reason as `icon` below. maxlength already bounds a typed value; the slice is for
    // one that arrived some other way.
    label: String(result.label ?? "").trim().slice(0, MAX_PAD_LABEL_LENGTH) || null,
    volume: foundry.audio.AudioHelper.inputToVolume(Number(result.volume)),
    loop: result.mode === "loop",
    color: result.colorEnabled ? result.color : null,
    // "" when the field was cleared, which is the GM asking for the default back — stored as null
    // so the pad follows DEFAULT_PAD_ICON rather than freezing today's value.
    icon: String(result.icon ?? "").trim() || null,
    random: { enabled: result.mode === "random", ...readRandomRange(result) }
  };
}

/**
 * A soundboard's background colour: the same optional-colour pair as a pad's (a switch and a
 * picker), for the whole board. Stored in ContainerFlags.color, which the API already accepted as
 * a container's accent colour and nothing in the console had drawn yet.
 * @param {{name: string, color: string|null}} board
 * @returns {Promise<{color: string|null}|null>}
 */
export async function promptBoardColor({ name, color }) {
  const result = await DialogV2.input({
    window: { title: t("AUDIO_CONSOLE.Soundboard.Dialogs.BoardColorTitle", { name }), icon: "fa-solid fa-palette" },
    classes: DIALOG_CLASSES,
    position: { width: 400 },
    content: `
      <div class="ac-wide-labels">
      <div class="form-group">
        <label for="ac-board-color-enabled">${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.ColorLabel"))}</label>
        <div class="form-fields">
          <input id="ac-board-color-enabled" type="checkbox" name="colorEnabled"${color ? " checked" : ""}>
          <input id="ac-board-color" type="color" name="color" value="${color ?? "#d4af37"}">
        </div>
        <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.BoardColorHint"))}</p>
      </div>
      </div>`,
    ok: { label: t("AUDIO_CONSOLE.Soundboard.Dialogs.ConfigSubmit"), icon: "fa-solid fa-check" }
  });
  if (!result) return null;
  return { color: result.colorEnabled ? result.color : null };
}

/* -------------------------------------------- */
/*  Ambience                                     */
/* -------------------------------------------- */

/**
 * An ambience layer's playback: the pad config's Sound tab — duration, volume, the Playback choice
 * and the random range — plus the one setting only a layer has, whether it also plays when the
 * ambience starts. That one sits inside the random fieldset because it only means something there.
 * One tab rather than the pad's two: a layer has no name, colour or icon of its own.
 *
 * Volume and loop are also live controls on the mixer row; this is the same two fields, not a
 * second copy of them.
 * @param {{name: string, path: string, volume: number, loop: boolean,
 *   random: {enabled: boolean, interval: number, variance: number, onStart: boolean}}} layer
 * @returns {Promise<{volume: number, loop: boolean,
 *   random: {enabled: boolean, interval: number, variance: number, onStart: boolean}}|null>}
 */
export async function promptLayerPlayback({ name, path, volume, loop, random }) {
  const result = await DialogV2.input({
    window: { title: t("AUDIO_CONSOLE.Ambience.Dialogs.PlaybackTitle", { name }), icon: "fa-solid fa-dice" },
    classes: DIALOG_CLASSES,
    position: { width: 480 },
    content: `
      <div class="ac-wide-labels">
      <div class="form-group">
        <label>${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.DurationLabel"))}</label>
        <div class="form-fields"><span class="ac-duration-value" data-duration>…</span></div>
      </div>
      ${volumeField("ac-layer", volume)}
      ${playbackField(loop, random.enabled)}
      <fieldset data-random-fields${random.enabled ? "" : " hidden"}>
        <legend>${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.RandomLegend"))}</legend>
        ${randomRangeFields("ac-layer", random)}
        <div class="form-group">
          <label for="ac-layer-on-start">${escapeHTML(t("AUDIO_CONSOLE.Ambience.Dialogs.OnStartLabel"))}</label>
          <div class="form-fields"><input id="ac-layer-on-start" type="checkbox" name="onStart"${random.onStart ? " checked" : ""}></div>
          <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Ambience.Dialogs.OnStartHint"))}</p>
        </div>
      </fieldset>
      </div>`,
    ok: { label: t("AUDIO_CONSOLE.Soundboard.Dialogs.ConfigSubmit"), icon: "fa-solid fa-check" },
    render: (event, dialog) => {
      bindSliderReadout(dialog.element);
      bindDuration(dialog.element, path);
      bindPlaybackMode(dialog);
    }
  });
  if (!result) return null;
  return {
    volume: foundry.audio.AudioHelper.inputToVolume(Number(result.volume)),
    loop: result.mode === "loop",
    random: { enabled: result.mode === "random", ...readRandomRange(result), onStart: !!result.onStart }
  };
}

/* -------------------------------------------- */

/**
 * Pick the one player a pad is sent to. A select-and-confirm rather than a button per user: a
 * table of eight would otherwise put eight buttons in a dialog footer, and this
 * list is whoever happens to be logged in, which is not a number this module gets to assume.
 *
 * The hint is not decoration. This is the one control in the module that reaches a player's
 * speakers without the transport's mode saying so, so the dialog says who hears it, in words,
 * every time.
 *
 * @param {{padName: string, users: {id: string, name: string}[]}} options
 * @returns {Promise<string|null>} The chosen user id.
 */
export async function promptWhisperTarget({ padName, users }) {
  const options = users.map(u => `<option value="${u.id}">${escapeHTML(u.name)}</option>`).join("");
  const result = await DialogV2.input({
    window: { title: t("AUDIO_CONSOLE.Soundboard.Dialogs.WhisperTitle", { name: padName }), icon: "fa-solid fa-paper-plane" },
    classes: DIALOG_CLASSES,
    position: { width: 420 },
    content: `
      <div class="form-group">
        <label for="ac-whisper-user">${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.WhisperLabel"))}</label>
        <div class="form-fields"><select id="ac-whisper-user" name="user">${options}</select></div>
      </div>
      <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Soundboard.Dialogs.WhisperHint"))}</p>`,
    ok: { label: t("AUDIO_CONSOLE.Soundboard.Dialogs.WhisperSubmit"), icon: "fa-solid fa-paper-plane" }
  });
  return result?.user || null;
}

/* -------------------------------------------- */
/*  Library maintenance                          */
/* -------------------------------------------- */

// These dialogs are the console's own surfaces like every other one in this file — DIALOG_CLASSES
// puts the module scope on the frame, so they use core's dialog classes (.hint, .notification)
// alongside ours. A long list that would otherwise grow the window past the screen scrolls inside
// .ac-dialog-scroll (styles/dialogs.css).

/**
 * Both destructive operations offer this first: consolidate, and a Replace import. The real backup
 * is a copy outside the data folder, so this is the moment to take one.
 * @param {{question: string}} options
 * @returns {Promise<"export"|"continue"|null>}
 */
export async function promptExportFirst({ question }) {
  const result = await DialogV2.wait({
    window: { title: t("AUDIO_CONSOLE.Library.Maintenance.ExportFirstTitle"), icon: "fa-solid fa-download" },
    classes: DIALOG_CLASSES,
    position: { width: 480 },
    content: `
      <p>${escapeHTML(question)}</p>
      <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Library.Maintenance.ExportFirstHint"))}</p>`,
    buttons: [
      {
        action: "export",
        label: t("AUDIO_CONSOLE.Library.Maintenance.ExportFirstExport"),
        icon: "fa-solid fa-download",
        default: true,
        callback: () => "export"
      },
      {
        action: "continue",
        label: t("AUDIO_CONSOLE.Library.Maintenance.ExportFirstContinue"),
        icon: "fa-solid fa-arrow-right",
        callback: () => "continue"
      },
      {
        action: "cancel",
        label: t("AUDIO_CONSOLE.Library.Maintenance.Cancel"),
        icon: "fa-solid fa-xmark",
        callback: () => null
      }
    ]
  });
  return chosen(result, ["export", "continue"]);
}

/**
 * The consolidate preview. Not optional and not summarised away: every rename is listed, because
 * the copies cannot be undone from inside Foundry. The full list is rendered at once — a few
 * thousand rows measured at ~17 ms in a one-time modal build — and scrolls in place.
 * @param {object} plan From planConsolidation().
 * @returns {Promise<boolean>}
 */
export async function confirmConsolidate(plan) {
  const renames = plan.copies.map(copy => `
    <li>${escapeHTML(copy.name)}
      <span class="hint">${escapeHTML(copy.path)} → ${escapeHTML(copy.newPath)}</span>
    </li>`).join("");

  const collisions = plan.collisions.length ? `
    <p><strong>${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.Collisions", { count: plan.collisions.length }))}</strong></p>
    <ul>${plan.collisions.map(collision => `<li class="hint">${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.CollisionRow", collision))}</li>`).join("")}</ul>` : "";

  const skipped = plan.skipped.length ? `
    <p><strong>${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.Skipped", { count: plan.skipped.length }))}</strong></p>
    <ul>${plan.skipped.map(entry => `<li class="hint">${escapeHTML(entry.name)} — ${escapeHTML(skipReason(entry.reason))}</li>`).join("")}</ul>` : "";

  const unmeasured = plan.unmeasured
    ? `<p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.Unmeasured", { count: plan.unmeasured }))}</p>` : "";

  return DialogV2.confirm({
    window: { title: t("AUDIO_CONSOLE.Library.Consolidate.Title"), icon: "fa-solid fa-boxes-packing" },
    classes: DIALOG_CLASSES,
    position: { width: 640, height: 700 },
    content: `
      <p>${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.Intro", {
        count: plan.copies.length, dir: `${LIBRARY_DIR}/audio/`, size: formatBytes(plan.bytes)
      }))}</p>
      ${unmeasured}
      <p class="notification warning">${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.OriginalsNotice"))}</p>
      <p class="notification info">${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.DiskNotice"))}</p>
      <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.PlayingNotice"))}</p>
      ${collisions}
      ${skipped}
      <p><strong>${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.Renames"))}</strong></p>
      <div class="ac-dialog-scroll"><ul>${renames}</ul></div>`,
    yes: {
      label: t("AUDIO_CONSOLE.Library.Consolidate.Submit", { count: plan.copies.length }),
      icon: "fa-solid fa-boxes-packing"
    }
  });
}

/** @param {string} reason One of SKIP_REASONS. @returns {string} */
function skipReason(reason) {
  return reason === SKIP_REASONS.REMOTE
    ? t("AUDIO_CONSOLE.Library.Consolidate.SkipRemote")
    : t("AUDIO_CONSOLE.Library.Consolidate.SkipAlready");
}

/**
 * The progress readout for the copy loop. Stays open across the whole run — so it is a live
 * DialogV2 instance rather than one of the static helpers, all of which resolve by closing.
 * Cancelling is deliberately only observed *between* files: a half-written upload is worse than
 * one more file.
 * @param {{total: number}} options
 * @returns {{ready: Promise<*>, update: Function, isCancelled: () => boolean, close: Function}}
 */
export function openConsolidateProgress({ total }) {
  let cancelled = false;
  let finished = false;
  const dialog = new DialogV2({
    window: { title: t("AUDIO_CONSOLE.Library.Consolidate.ProgressTitle"), icon: "fa-solid fa-boxes-packing" },
    classes: DIALOG_CLASSES,
    position: { width: 460 },
    content: `
      <p data-progress-count>${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.ProgressCount", { done: 0, total }))}</p>
      <progress data-progress-bar max="${total}" value="0"></progress>
      <p class="hint" data-progress-name></p>`,
    buttons: [{
      action: "cancel",
      label: t("AUDIO_CONSOLE.Library.Consolidate.CancelRun"),
      icon: "fa-solid fa-xmark",
      callback: () => { cancelled = true; }
    }]
  });
  // Dismissing the window is the same intent as pressing Cancel; closing it ourselves at the end
  // is not, hence the flag.
  dialog.addEventListener("close", () => { if (!finished) cancelled = true; }, { once: true });

  return {
    ready: dialog.render({ force: true }),
    update(done, totalCount, name) {
      const root = dialog.element;
      if (!root) return;
      root.querySelector("[data-progress-count]").textContent =
        t("AUDIO_CONSOLE.Library.Consolidate.ProgressCount", { done, total: totalCount });
      root.querySelector("[data-progress-bar]").value = done;
      root.querySelector("[data-progress-name]").textContent = name;
    },
    isCancelled: () => cancelled,
    async close() {
      finished = true;
      if (dialog.rendered) await dialog.close();
    }
  };
}

/**
 * What actually happened, next to where the report file landed.
 * @param {object} report From runConsolidation().
 * @returns {Promise<void>}
 */
export async function showConsolidationReport(report) {
  const failures = report.failed.length ? `
    <ul>${report.failed.map(entry => `<li class="hint">${escapeHTML(entry.name)} — ${escapeHTML(entry.reason)}</li>`).join("")}</ul>` : "";
  await DialogV2.prompt({
    window: { title: t("AUDIO_CONSOLE.Library.Consolidate.ReportTitle"), icon: "fa-solid fa-clipboard-check" },
    classes: DIALOG_CLASSES,
    position: { width: 520 },
    content: `
      ${report.cancelled ? `<p class="notification warning">${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.ReportCancelled"))}</p>` : ""}
      <ul>
        <li>${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.ReportCopied", { count: report.copied.length }))}</li>
        <li>${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.ReportFailed", { count: report.failed.length }))}</li>
        <li>${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.ReportSkipped", { count: report.skipped.length }))}</li>
        <li>${escapeHTML(t("AUDIO_CONSOLE.Library.Consolidate.ReportRepointed", {
          entries: report.repointed.entries, sounds: report.repointed.sounds
        }))}</li>
      </ul>
      ${failures}
      <p class="hint">${escapeHTML(report.reportPath
        ? t("AUDIO_CONSOLE.Library.Consolidate.ReportWritten", { path: report.reportPath })
        : t("AUDIO_CONSOLE.Library.Consolidate.ReportNotWritten"))}</p>`,
    ok: { label: t("AUDIO_CONSOLE.Library.Maintenance.Close"), icon: "fa-solid fa-check" }
  });
}

/**
 * Pick a catalogue file from this machine and say what to do with it. Two submit buttons rather
 * than a mode selector, so the destructive choice is named on the control that performs it.
 * @returns {Promise<{file: File, mode: "merge"|"replace"}|null>}
 */
export async function promptImport() {
  let file = null;
  const result = await DialogV2.wait({
    window: { title: t("AUDIO_CONSOLE.Library.Maintenance.ImportTitle"), icon: "fa-solid fa-file-import" },
    classes: DIALOG_CLASSES,
    position: { width: 520 },
    content: `
      <p>${escapeHTML(t("AUDIO_CONSOLE.Library.Maintenance.ImportIntro"))}</p>
      <div class="form-group">
        <label for="ac-import-file">${escapeHTML(t("AUDIO_CONSOLE.Library.Maintenance.ImportFileLabel"))}</label>
        <div class="form-fields">
          <input id="ac-import-file" type="file" accept="application/json,.json" data-import-file>
        </div>
      </div>
      <p class="hint"><strong>${escapeHTML(t("AUDIO_CONSOLE.Library.Maintenance.ImportMerge"))}:</strong> ${escapeHTML(t("AUDIO_CONSOLE.Library.Maintenance.ImportMergeHint"))}</p>
      <p class="hint"><strong>${escapeHTML(t("AUDIO_CONSOLE.Library.Maintenance.ImportReplace"))}:</strong> ${escapeHTML(t("AUDIO_CONSOLE.Library.Maintenance.ImportReplaceHint"))}</p>`,
    buttons: [
      {
        action: "merge",
        label: t("AUDIO_CONSOLE.Library.Maintenance.ImportMerge"),
        icon: "fa-solid fa-code-merge",
        default: true,
        callback: () => "merge"
      },
      {
        action: "replace",
        label: t("AUDIO_CONSOLE.Library.Maintenance.ImportReplace"),
        icon: "fa-solid fa-arrows-rotate",
        callback: () => "replace"
      },
      {
        action: "cancel",
        label: t("AUDIO_CONSOLE.Library.Maintenance.Cancel"),
        icon: "fa-solid fa-xmark",
        callback: () => null
      }
    ],
    render: (event, dialog) => {
      dialog.element.querySelector("[data-import-file]")
        .addEventListener("change", changeEvent => { file = changeEvent.target.files[0] ?? null; });
    }
  });
  const mode = chosen(result, ["merge", "replace"]);
  if (!mode || !file) return null;
  return { file, mode };
}

/**
 * Replace is the destructive import: the catalogue becomes the file exactly, so the confirmation
 * names how many rows — and therefore how many hand-curated tag sets — that drops.
 * @param {{currentCount: number, incomingCount: number, removedCount: number}} counts
 * @returns {Promise<boolean>}
 */
export async function confirmReplaceImport({ currentCount, incomingCount, removedCount }) {
  return DialogV2.confirm({
    window: { title: t("AUDIO_CONSOLE.Library.Maintenance.ReplaceTitle"), icon: "fa-solid fa-arrows-rotate" },
    classes: DIALOG_CLASSES,
    position: { width: 520 },
    content: `
      <p>${escapeHTML(t("AUDIO_CONSOLE.Library.Maintenance.ReplaceQuestion", { current: currentCount, incoming: incomingCount }))}</p>
      <p class="notification warning">${escapeHTML(t("AUDIO_CONSOLE.Library.Maintenance.ReplaceRemoved", { count: removedCount }))}</p>`,
    yes: { label: t("AUDIO_CONSOLE.Library.Maintenance.ReplaceSubmit"), icon: "fa-solid fa-arrows-rotate" }
  });
}

/**
 * A pack sync is the one thing that overwrites what the GM may have tuned by hand, so the
 * question spells out both lists — what the pack's spec will write, and what stays the GM's.
 * @param {{name: string, containers: number}} pack
 * @returns {Promise<boolean>}
 */
export async function confirmSyncPack({ name, containers }) {
  return DialogV2.confirm({
    window: { title: t("AUDIO_CONSOLE.Settings.LibraryMaintenance.Packs.SyncTitle"), icon: "fa-solid fa-rotate" },
    classes: DIALOG_CLASSES,
    position: { width: 520 },
    content: `
      <p>${escapeHTML(t("AUDIO_CONSOLE.Settings.LibraryMaintenance.Packs.SyncQuestion", { name, count: containers }))}</p>
      <p class="notification warning">${escapeHTML(t("AUDIO_CONSOLE.Settings.LibraryMaintenance.Packs.SyncOverwrites"))}</p>
      <p>${escapeHTML(t("AUDIO_CONSOLE.Settings.LibraryMaintenance.Packs.SyncKeeps"))}</p>`,
    yes: { label: t("AUDIO_CONSOLE.Settings.LibraryMaintenance.Packs.SyncSubmit"), icon: "fa-solid fa-rotate" }
  });
}

/* -------------------------------------------- */
/*  Automation                                  */
/* -------------------------------------------- */

/**
 * `<option>` markup for a plain value→label map, with one option pre-selected.
 * @param {Record<string, string>} choices
 * @param {string} selected
 * @returns {string}
 */
function optionsFor(choices, selected) {
  return Object.entries(choices)
    .map(([value, label]) =>
      `<option value="${escapeHTML(value)}"${value === selected ? " selected" : ""}>${escapeHTML(label)}</option>`)
    .join("");
}

/**
 * The rule editor, used for both "new rule" and "edit rule" — the difference is only which values
 * it opens on and what its submit button says.
 *
 * Fields that belong to one trigger or one action are all present in the markup and shown or
 * hidden by `data-when-*`, rather than the dialog being re-rendered per type. A DialogV2's content
 * is a string handed over once; swapping it live would mean rebuilding the form and losing
 * everything already typed into the fields the change did not affect.
 *
 * @param {object} options
 * @param {object} options.rule The rule to edit, as a plain object (a new rule's schema initials
 *   serve perfectly well here).
 * @param {Record<string, string>} options.weatherChoices Every registered weather, blank included.
 * @param {Record<string, string>} options.sceneChoices Every scene, by id.
 * @param {Record<string, string>} options.triggerChoices
 * @param {{label: string, options: Record<string, string>}[]} options.actionGroups
 * @param {Record<string, string>} options.operatorChoices
 * @param {{id: string, name: string, kind: string, sounds: {id: string, name: string}[]}[]} options.containers
 * @param {Record<string, {kind: string|null, entry: boolean, stop: boolean}>} options.actions
 *   The ACTIONS table — what each action targets and needs.
 * @param {boolean} options.isNew
 * @returns {Promise<object|null>} A partial rule, or null if dismissed.
 */
export async function promptAutomationRule({
  rule, weatherChoices, sceneChoices, triggerChoices, actionGroups, operatorChoices, containers, actions, isNew
}) {
  // A new rule's sceneId is blank; the first choice (the active scene) is what it should open on.
  const selectedScene = rule.trigger.sceneId || Object.keys(sceneChoices)[0] || "";
  const hours = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), `${String(h).padStart(2, "0")}:00`]));
  const soundsByContainer = Object.fromEntries(containers.map(c => [c.id, c.sounds]));
  const selectedContainer = rule.action.containerId || containers[0]?.id || "";

  const soundOptions = (soundsByContainer[selectedContainer] ?? [])
    .map(s => `<option value="${escapeHTML(s.id)}"${s.id === rule.action.soundId ? " selected" : ""}>${escapeHTML(s.name)}</option>`)
    .join("");

  const result = await DialogV2.input({
    window: {
      title: t(isNew ? "AUDIO_CONSOLE.Automation.Dialogs.NewTitle" : "AUDIO_CONSOLE.Automation.Dialogs.EditTitle"),
      icon: "fa-solid fa-wand-magic-sparkles"
    },
    classes: DIALOG_CLASSES,
    position: { width: 520 },
    content: `
      <div class="ac-wide-labels ac-rule-form">
      <div class="form-group">
        <label for="ac-rule-trigger">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.TriggerLabel"))}</label>
        <div class="form-fields">
          <select id="ac-rule-trigger" name="triggerType" data-rule-trigger>${optionsFor(triggerChoices, rule.trigger.type)}</select>
        </div>
      </div>

      <div class="form-group" data-when-trigger="weather">
        <label for="ac-rule-weather">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.WeatherLabel"))}</label>
        <div class="form-fields">
          <select id="ac-rule-weather" name="weather">${optionsFor(weatherChoices, rule.trigger.weather)}</select>
        </div>
        <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.WeatherHint"))}</p>
      </div>

      <div class="form-group" data-when-trigger="darkness">
        <label for="ac-rule-operator">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.DarknessLabel"))}</label>
        <div class="form-fields ac-rule-darkness">
          <select id="ac-rule-operator" name="operator">${optionsFor(operatorChoices, rule.trigger.operator)}</select>
          <input id="ac-rule-threshold" type="number" name="threshold" min="0" max="1" step="0.05" value="${rule.trigger.threshold}">
        </div>
        <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.DarknessHint"))}</p>
      </div>

      <div class="form-group" data-when-trigger="scene">
        <label for="ac-rule-scene">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.SceneLabel"))}</label>
        <div class="form-fields">
          <select id="ac-rule-scene" name="sceneId">${optionsFor(sceneChoices, selectedScene)}</select>
        </div>
        <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.SceneHint"))}</p>
      </div>

      <div class="form-group" data-when-trigger="time">
        <label for="ac-rule-from-hour">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.TimeLabel"))}</label>
        <div class="form-fields ac-rule-darkness">
          <select id="ac-rule-from-hour" name="fromHour">${optionsFor(hours, String(rule.trigger.fromHour))}</select>
          <span>${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.TimeTo"))}</span>
          <select id="ac-rule-to-hour" name="toHour">${optionsFor(hours, String(rule.trigger.toHour))}</select>
        </div>
        <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.TimeHint"))}</p>
      </div>

      <div class="form-group">
        <label for="ac-rule-action">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.ActionLabel"))}</label>
        <div class="form-fields">
          <select id="ac-rule-action" name="actionType" data-rule-action>${actionGroups.map(group =>
            `<optgroup label="${escapeHTML(group.label)}">${optionsFor(group.options, rule.action.type)}</optgroup>`
          ).join("")}</select>
        </div>
      </div>

      <div class="form-group" data-needs-target>
        <label for="ac-rule-container">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.ContainerLabel"))}</label>
        <div class="form-fields">
          <select id="ac-rule-container" name="containerId" data-rule-container></select>
        </div>
        <p class="hint">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.TargetHint"))}</p>
      </div>

      <div class="form-group" data-needs-entry>
        <label for="ac-rule-sound">${escapeHTML(t("AUDIO_CONSOLE.Automation.Dialogs.SoundLabel"))}</label>
        <div class="form-fields">
          <select id="ac-rule-sound" name="soundId" data-rule-sound>${soundOptions}</select>
        </div>
      </div>


      </div>`,
    ok: {
      label: t(isNew ? "AUDIO_CONSOLE.Automation.Dialogs.CreateSubmit" : "AUDIO_CONSOLE.Automation.Dialogs.SaveSubmit"),
      icon: "fa-solid fa-check"
    },
    render: (event, dialog) => bindRuleForm(dialog.element, containers, actions, {
      containerId: selectedContainer,
      soundId: rule.action.soundId
    })
  });
  if (!result) return null;

  return {
    trigger: {
      type: result.triggerType,
      weather: result.weather ?? "",
      operator: result.operator,
      threshold: Math.clamp(Number(result.threshold) || 0, 0, 1),
      sceneId: result.sceneId ?? "",
      fromHour: numberOr(result.fromHour, 20, 0, 23),
      toHour: numberOr(result.toHour, 6, 0, 23)
    },
    action: {
      type: result.actionType,
      containerId: result.containerId ?? "",
      soundId: result.soundId ?? ""
    }
  };
}

/**
 * Keeps the rule form coherent as the GM changes their mind: which conditional fields are on
 * screen, which containers the action is even allowed to name, and which tracks live in the one
 * they picked.
 *
 * `hidden` rather than a class: a hidden form control is still submitted, which is what lets the
 * caller read `result.weather` unconditionally instead of having to know which fields were shown.
 *
 * The target list is rebuilt rather than merely filtered. Each action names exactly one container
 * kind, so the list under it is the whole answer — there is no mixed list to scan past, and
 * choosing "play one pad" has already chosen the soundboards.
 * @param {HTMLElement} root
 * @param {{id: string, name: string, kind: string, sounds: {id: string, name: string}[]}[]} containers
 * @param {Record<string, {kind: string|null, entry: boolean, stop: boolean}>} actions
 * @param {{containerId: string, soundId: string}} initial What the rule already pointed at, so
 *   reopening an existing rule lands on its own target instead of the first in the list.
 */
function bindRuleForm(root, containers, actions, initial) {
  const triggerSelect = root.querySelector("[data-rule-trigger]");
  const actionSelect = root.querySelector("[data-rule-action]");
  const containerSelect = root.querySelector("[data-rule-container]");
  const soundSelect = root.querySelector("[data-rule-sound]");
  const byId = Object.fromEntries(containers.map(c => [c.id, c]));
  const spec = () => actions[actionSelect.value] ?? { kind: null, entry: false, stop: false };

  const options = (items, selected) => items
    .map(i => `<option value="${escapeHTML(i.id)}"${i.id === selected ? " selected" : ""}>${escapeHTML(i.name)}</option>`)
    .join("");

  const fillSounds = selected => {
    const sounds = byId[containerSelect.value]?.sounds ?? [];
    soundSelect.innerHTML = options(sounds, selected);
  };

  const fillContainers = () => {
    const { kind } = spec();
    const eligible = kind ? containers.filter(c => c.kind === kind) : [];
    // Keep the current target if the new action still permits it; otherwise fall to the first one
    // that is permitted, so the field is never left showing something the action cannot do.
    const keep = eligible.some(c => c.id === containerSelect.value) ? containerSelect.value
      : (eligible.some(c => c.id === initial.containerId) ? initial.containerId : eligible[0]?.id ?? "");
    containerSelect.innerHTML = options(eligible, keep);
    containerSelect.value = keep;
    fillSounds(initial.soundId);
  };

  const sync = () => {
    for (const group of root.querySelectorAll("[data-when-trigger]")) {
      group.hidden = group.dataset.whenTrigger !== triggerSelect.value;
    }
    const { kind, entry } = spec();
    // "Stop everything" names nothing, so the target picker goes away with it.
    for (const group of root.querySelectorAll("[data-needs-target]")) group.hidden = !kind;
    for (const group of root.querySelectorAll("[data-needs-entry]")) group.hidden = !entry;
  };

  triggerSelect.addEventListener("change", sync);
  actionSelect.addEventListener("change", () => { fillContainers(); sync(); });
  containerSelect.addEventListener("change", () => fillSounds(""));
  fillContainers();
  sync();
}
