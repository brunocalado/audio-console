/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID, AUDIO_MODES, CONTAINER_KINDS, DISPLAY_MODES, LIBRARY_CHANGED_HOOK, SETTINGS } from "../constants.js";
import { basenameOf, formatDuration, humanizeName } from "../helpers.js";
import { onContainerChange, onPlaybackChange } from "../data/sync.js";
import { containerKindOf, getActiveEntry, isPaused } from "../data/repository.js";
import { updateEntries } from "../data/mutations.js";
import * as library from "../library/index.js";
import * as playback from "../audio/playback.js";
import * as preview from "../audio/preview.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// How often the transport bar re-reads the live Sound while something is playing. Only the
// transport's own elements are written; nothing here renders.
const TICK_MS = 500;

// Keyboard seek steps, in seconds. An arrow is a nudge inside a phrase; PageUp/PageDown is a jump
// between them. Both are absolute rather than a fraction of the duration, so the key does the same
// thing on a 30-second sting as on an hour-long ambience loop.
const SEEK_STEP_S = 5;
const SEEK_PAGE_S = 30;

/**
 * The first finite position among the candidates, or 0.
 *
 * Neither source can be trusted to be a number. Sound#currentTime returns `undefined` whenever the
 * Sound is not playing — so a paused preview, or one parked by a seek, has to fall back to
 * pausedTime or the bar snaps to 0:00 the moment it stops. Worse, it returns **NaN** during the
 * STARTING window: `playing` is already true while `startTime` is still unset, and the getter is
 * `context.currentTime - undefined` (v14.367 client/audio/sound.mjs). `??` does not catch NaN, and
 * a NaN that reaches seekEntry() is written straight to pausedTime, where Foundry rejects it with a
 * DataModelValidationError — observed live before this guard existed. PlaylistSound#pausedTime is
 * itself `nullable, required: false`, so it arrives as null or undefined just as readily.
 *
 * @param {...(number|null|undefined)} candidates
 * @returns {number}
 */
function finiteTime(...candidates) {
  return candidates.find(Number.isFinite) ?? 0;
}

/**
 * The intermediate base both console modes extend. It owns what normal and compact genuinely
 * share: the module CSS scope, the window identity, the re-render subscriptions to the two change
 * sources (module documents and the library catalogue), and the transport bar — its actions, its
 * direct-DOM update path, and the preview/broadcast interlock. Everything else — PARTS, TABS,
 * position, per-mode actions — belongs to the leaves.
 *
 * A leaf opts into the transport by rendering an element carrying the `data-transport-*` contract
 * that #bindTransport reads. A leaf without one simply never gets an update.
 */
export class AudioConsoleApplication extends HandlebarsApplicationMixin(ApplicationV2) {

  /**
   * BASE_APPLICATION stops `inheritanceChain()`, and `_initializeApplicationOptions()` only merges
   * the DEFAULT_OPTIONS of classes down to that floor. Setting it here therefore drops
   * ApplicationV2's own defaults — `tag`, `window.frame`, `window.positioned`, the attach/detach
   * header controls and their handlers — for both leaves, and a frameless positionless window is
   * the result, with no error to point at. Folding them back in explicitly is what core's own
   * BasePlaceableHUD does for the same reason (verified in v14.365
   * client/applications/api/application.mjs).
   */
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(ApplicationV2.DEFAULT_OPTIONS, {
    id: MODULE_ID,
    // The CSS scope root. Every rule in this module's stylesheets is nested inside it.
    classes: [MODULE_ID],
    window: {
      title: "AUDIO_CONSOLE.Window.Title",
      icon: "fa-solid fa-sliders"
    },
    // The transport controls both modes need. Leaf actions merge on top of these.
    actions: {
      transportToggle: AudioConsoleApplication.#onTransportToggle,
      transportPrevious: AudioConsoleApplication.#onTransportPrevious,
      transportNext: AudioConsoleApplication.#onTransportNext,
      transportStop: AudioConsoleApplication.#onTransportStop,
      transportRepeat: AudioConsoleApplication.#onTransportRepeat,
      transportMode: AudioConsoleApplication.#onTransportMode
    }
  }, { inplace: false });

  /**
   * Set here and nowhere else. On a leaf it would silently discard ApplicationV2's defaults; see
   * the note on DEFAULT_OPTIONS above.
   * @override
   */
  static BASE_APPLICATION = AudioConsoleApplication;

  /**
   * Which PART draws each kind of container, so a change to one section can redraw that section
   * alone (#renderSections). Note the one plural: the section is "playlists", the kind is
   * "playlist". A mode whose PARTS lack an entry here simply redraws whole.
   */
  static CONTAINER_PARTS = {
    [CONTAINER_KINDS.PLAYLIST]: "playlists",
    [CONTAINER_KINDS.SOUNDBOARD]: "soundboard",
    [CONTAINER_KINDS.AMBIENCE]: "ambience",
    [CONTAINER_KINDS.QUEUE]: "queue"
  };

  /**
   * Render (or bring forward) the single instance of this console mode.
   * @returns {Promise<AudioConsoleApplication>}
   */
  static open() {
    const existing = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id);
    if (existing) {
      existing.bringToFront();
      return existing;
    }
    return new this().render({ force: true });
  }

  /** @type {(() => void)|null} */
  #unsubscribeContainers = null;

  /** @type {(() => void)|null} */
  #unsubscribePlayback = null;

  /** @type {number|null} */
  #libraryHookId = null;

  /** @type {HTMLElement|null} The transport root the cached children below were read from. */
  #transportRoot = null;

  /** @type {Record<string, HTMLElement|null>} */
  #transport = {};

  /** @type {number|null} */
  #tickId = null;

  /**
   * The 0–1 position a seek drag is currently sitting at, or null when nothing is being dragged.
   * While it is set it wins over the live playback position everywhere the bar is painted, so the
   * twice-a-second tick cannot yank the handle back out from under the pointer mid-drag.
   * @type {number|null}
   */
  #seekRatio = null;

  /** @type {string|null} The PlaylistSound id already warned about this session's load failure. */
  #notifiedFailedId = null;

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /**
   * Redraw for a catalogue change.
   *
   * The base answers with a full render, which is the right answer for the compact bar: it has one
   * part and nothing to narrow. AudioConsoleNormal overrides this to redraw the Library plus only
   * those sections currently showing one of the changed paths.
   *
   * Not `_`-prefixed: it overrides nothing of Foundry's. It is this module's own seam between the
   * two console modes, and the naming rule in CLAUDE.md reserves the underscore for the other case.
   * @param {{paths: Set<string>|null, vocabulary: boolean}} change See library/index.js. `paths`
   *   is null when the change was too broad to enumerate.
   */
  renderForLibraryChange(change) {
    this.render();
  }

  /**
   * Redraw only the sections a change actually touched.
   *
   * A whole-window redraw is 145 ms with a 300-track playlist selected against 11 ms for one part
   * (v14.367, 1534-entry library) — and an Ambience loop toggle would pay the full price for a
   * change no other section could see.
   *
   * Falls back to a full render whenever the change cannot be attributed (`null` — a section
   * folder moved) or names nothing this class draws (the compact bar has no section parts at all,
   * and redrawing it whole is cheap).
   * @param {Set<string>|null} kinds CONTAINER_KINDS values, per sync.js.
   */
  #renderSections(kinds) {
    if (!kinds?.size) return void this.render();
    const parts = [...kinds]
      .map(kind => AudioConsoleApplication.CONTAINER_PARTS[kind])
      .filter(part => part && (part in this.constructor.PARTS));
    if (!parts.length) return void this.render();
    // The rail rides along with every container change, because it lists favourites: a container
    // renamed, deleted, or pinned changes what the rail shows as surely as it changes the section
    // that owns it. Guarded on PARTS, so compact mode — which has no rail — is unaffected.
    if ("rail" in this.constructor.PARTS) parts.push("rail");
    this.render({ parts });
  }

  /**
   * Both change sources are debounced upstream — sync.js at 100 ms, library/index.js at 100 ms —
   * so this subscribes to them raw rather than adding a third timer.
   *
   * Deliberately not `_onFirstRender`: that only runs while the render state is NONE, so an
   * instance that was closed and rendered again would come back with no subscriptions and quietly
   * stop reacting to changes. The guard keeps it to one subscription per instance either way.
   * @inheritDoc
   */
  _onRender(context, options) {
    super._onRender(context, options);
    this.#bindTransport();
    if (this.#unsubscribeContainers) return;
    this.#unsubscribeContainers = onContainerChange(kinds => this.#renderSections(kinds));
    // Playback state gets the direct-DOM path instead. Re-rendering the library grid because a
    // progress bar moved is the performance mistake this module is most likely to make.
    this.#unsubscribePlayback = onPlaybackChange(() => this.updateTransport());
    this.#libraryHookId = foundry.helpers.Hooks.on(LIBRARY_CHANGED_HOOK, change => this.renderForLibraryChange(change));
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    this.#unsubscribeContainers?.();
    this.#unsubscribeContainers = null;
    this.#unsubscribePlayback?.();
    this.#unsubscribePlayback = null;
    if (this.#libraryHookId !== null) foundry.helpers.Hooks.off(LIBRARY_CHANGED_HOOK, this.#libraryHookId);
    this.#libraryHookId = null;
    this.#stopTick();
    this.#transportRoot = null;
    this.#transport = {};
    this.#seekRatio = null;
    // A preview Sound is owned by no document, so closing the window is the last chance anything
    // has to stop it. Broadcast is deliberately left alone: it belongs to the table, not to this
    // window.
    if (this.ownsPreview) preview.stopAll();
  }

  /* -------------------------------------------- */
  /*  The preview / broadcast interlock           */
  /* -------------------------------------------- */

  /**
   * Whether closing this window is what stops a running preview. True for a console proper; the
   * normal console's popouts (console-normal.js) answer false, since a preview started in the
   * full window has to survive one of its satellites closing.
   * @returns {boolean}
   */
  get ownsPreview() {
    return true;
  }

  /** @returns {string} One of AUDIO_MODES. */
  get audioMode() {
    return game.settings.get(MODULE_ID, SETTINGS.AUDIO_MODE);
  }

  /** @returns {boolean} Whether this GM is currently broadcasting to the table. */
  get isBroadcasting() {
    return this.audioMode === AUDIO_MODES.BROADCAST;
  }

  /**
   * Switch monitoring mode, stopping whatever the *other* path was playing first.
   *
   * This is the module's most dangerous control, so it is a safety interlock rather than a
   * preference: leaving audio playing at the table while the UI says "preview" is the exact
   * failure it exists to prevent, and there is no undo for a spoiled reveal.
   *
   * Every route into playback goes through here — the toggle button and the library row actions
   * alike — so the indicator can never describe a state the module is not actually in.
   *
   * @param {string} mode One of AUDIO_MODES.
   * @returns {Promise<void>}
   */
  async setAudioMode(mode) {
    if (this.audioMode !== mode) {
      if (mode === AUDIO_MODES.PREVIEW) await playback.stopEverything();
      else await preview.stopAll();
      await game.settings.set(MODULE_ID, SETTINGS.AUDIO_MODE, mode);
    }
    this.updateTransport();
  }

  /* -------------------------------------------- */
  /*  Display mode switching                      */
  /* -------------------------------------------- */

  /**
   * Switch between normal and compact, persisting the choice so the next launch — the scene
   * control button, the Playlists sidebar button — opens the same one, and always closing the
   * window being switched away from: two windows over one transport is a confusion generator.
   *
   * Dynamic import on purpose: both leaves import this base class, so importing either leaf back
   * from here at module-load time would be a static cycle. Resolved lazily, it isn't one.
   * @param {string} mode One of DISPLAY_MODES.
   * @returns {Promise<void>}
   */
  async switchDisplayMode(mode) {
    await game.settings.set(MODULE_ID, SETTINGS.DISPLAY_MODE, mode);
    const NextClass = mode === DISPLAY_MODES.COMPACT
      ? (await import("./console-compact.js")).AudioConsoleCompact
      : (await import("./console-normal.js")).AudioConsoleNormal;
    await this.close();
    NextClass.open();
  }

  /* -------------------------------------------- */
  /*  Transport bar — direct DOM, never a render  */
  /* -------------------------------------------- */

  /**
   * Cache the transport's elements and bind its one non-click listener. Cheap to call on every
   * render: a partial render leaves the transport element untouched, and the identity check makes
   * that case a plain update instead of a second `input` listener on the same slider.
   */
  #bindTransport() {
    const root = this.element?.querySelector("[data-transport]") ?? null;
    if (!root) {
      this.#transportRoot = null;
      this.#transport = {};
      this.#seekRatio = null;
      return;
    }
    if (root !== this.#transportRoot) {
      this.#transportRoot = root;
      this.#transport = {
        toggle: root.querySelector("[data-transport-toggle]"),
        toggleIcon: root.querySelector("[data-transport-toggle-icon]"),
        previous: root.querySelector("[data-transport-previous]"),
        next: root.querySelector("[data-transport-next]"),
        stop: root.querySelector("[data-transport-stop]"),
        repeat: root.querySelector("[data-transport-repeat]"),
        title: root.querySelector("[data-transport-title]"),
        subtitle: root.querySelector("[data-transport-subtitle]"),
        progress: root.querySelector("[data-transport-progress]"),
        fill: root.querySelector("[data-transport-fill]"),
        thumb: root.querySelector("[data-transport-thumb]"),
        time: root.querySelector("[data-transport-time]"),
        volume: root.querySelector("[data-transport-volume]"),
        mode: root.querySelector("[data-transport-mode]"),
        modeIcon: root.querySelector("[data-transport-mode-icon]"),
        modeLabel: root.querySelector("[data-transport-mode-label]")
      };
      this.#transport.volume?.addEventListener("input", this.#onVolumeInput);
      // Compact mode's bar carries no progress element, so it simply never binds these — the same
      // tolerance every other data-transport-* element gets.
      const bar = this.#transport.progress;
      if (bar) {
        bar.addEventListener("pointerdown", this.#onProgressPointerDown);
        bar.addEventListener("pointermove", this.#onProgressPointerMove);
        bar.addEventListener("pointerup", this.#onProgressPointerUp);
        bar.addEventListener("pointercancel", this.#onProgressPointerCancel);
        bar.addEventListener("keydown", this.#onProgressKeydown);
      }
    }
    this.updateTransport();
  }

  /**
   * What the transport is currently controlling. The mode decides which path is asked first, and
   * the other is the fallback, so the bar shows whatever is actually making sound rather than
   * whatever the setting says should be.
   * @returns {{live: boolean, sound: object|null, container: Playlist|null, name: string,
   *   context: string, playing: boolean, paused: boolean, currentTime: number, duration: number}}
   */
  #transportState() {
    const live = this.isBroadcasting;
    const resolved = live ? (this.#broadcastState() ?? this.#previewState())
      : (this.#previewState() ?? this.#broadcastState());
    return { live, ...(resolved ?? this.#emptyState()) };
  }

  /** @returns {object|null} */
  #broadcastState() {
    const active = getActiveEntry();
    if (!active) return null;
    const { container, sound } = active;
    const audio = sound.sound;

    // An ambience is a mix, not a track list: every layer sounds at once, so there is no "current
    // track" to name. getActiveEntry() has to return one of them, and naming that one would make
    // the bar read as if a single layer were playing.
    //
    // Keyed off the playlist mode and a count rather than off the container's kind: a soundboard
    // with two pads firing is the same situation and gets the same answer, while a soundboard with
    // one pad going is an ordinary single sound and still reads as one.
    const sounding = container.sounds.filter(s => s.playing);
    const mixed = (container.mode === foundry.CONST.PLAYLIST_MODES.SIMULTANEOUS) && (sounding.length > 1);

    return {
      kind: "broadcast",
      sound,
      container,
      mixed,
      name: mixed ? container.name : (sound.name || humanizeName(basenameOf(sound.path))),
      context: mixed
        ? game.i18n.format("AUDIO_CONSOLE.Transport.Mixed", { count: sounding.length })
        : container.name,
      playing: !!sound.playing,
      paused: isPaused(sound),
      currentTime: finiteTime(audio?.currentTime, sound.pausedTime),
      // A mix has no single position and no single level. Zero duration disables the seek bar on
      // its own (see `known` in updateTransport), and a null volume disables the fader — the
      // ambience mixer is where a layer's own level lives, and moving one arbitrary layer from
      // here under the container's name would be a lie about what the slider does.
      duration: mixed ? 0 : (audio?.duration ?? 0),
      volume: mixed ? null : sound.volume,
      // AudioHelper.play() (and the native playlist machinery that wraps it) resolves a Sound
      // even when the source 404s — it never throws — so a failed load is otherwise silent.
      failed: !!audio?.failed
    };
  }

  /** @returns {object|null} */
  #previewState() {
    const active = preview.getActive();
    if (!active) return null;
    const entry = library.getEntry(active.path);
    return {
      kind: "preview",
      sound: active.sound,
      container: null,
      name: entry?.name || humanizeName(basenameOf(active.path)),
      // Never the container name: a preview has no container, and saying so is half of what makes
      // the indicator honest.
      context: game.i18n.localize("AUDIO_CONSOLE.Transport.PreviewContext"),
      playing: !!active.sound.playing,
      paused: !active.sound.playing && (active.sound.pausedTime > 0),
      currentTime: finiteTime(active.sound.currentTime, active.sound.pausedTime),
      duration: active.sound.duration ?? 0,
      volume: active.sound.volume
    };
  }

  /** @returns {object} */
  #emptyState() {
    return {
      kind: null, sound: null, container: null,
      name: game.i18n.localize("AUDIO_CONSOLE.Transport.Idle"),
      context: "", playing: false, paused: false, currentTime: 0, duration: 0, volume: null
    };
  }

  /**
   * Write the transport's state straight into its elements. This is the whole reason playback
   * changes are routed away from the render path: a full render rebuilds the section chrome and
   * repaints the library rows, and a progress bar moving twice a second must not cost that.
   */
  updateTransport() {
    const t = this.#transport;
    if (!this.#transportRoot) return;
    const state = this.#transportState();
    const has = !!state.sound;

    // A broadcast track that failed to load is otherwise invisible: playing stays true on the
    // document (nothing about the write itself failed) and the progress bar simply never moves.
    // Warn once per sound rather than once per 500ms tick, and fold the failure into the same
    // missing-file signal the library table's own badge reads (it patches in next time that row
    // is painted or scrolled into view — this is not the place to reach into its DOM).
    if (!state.failed) {
      this.#notifiedFailedId = null;
    } else if (state.sound.id !== this.#notifiedFailedId) {
      this.#notifiedFailedId = state.sound.id;
      ui.notifications.warn(game.i18n.format("AUDIO_CONSOLE.Transport.Notify.PlaybackFailed", { name: state.name }));
      const entry = library.getEntry(state.sound.path);
      if (entry) {
        entry.missing = true;
        entry.missingChecked = true;
      }
    }

    if (t.title) {
      t.title.textContent = state.name;
      // Same opt-in rule as the tooltips below: a bar that declares `title` on this element gets it
      // kept current, one that omits it stays silent on hover. Normal mode wants it — its title can
      // truncate — and compact mode deliberately does not.
      if (t.title.hasAttribute("title")) t.title.title = state.name;
    }
    if (t.subtitle) t.subtitle.textContent = state.context;

    // Play/pause is one button with two meanings, so the icon and the label must both move —
    // a lone icon swap is exactly the "state in colour or shape alone" the contrast rules forbid.
    if (t.toggle) {
      const label = game.i18n.localize(state.playing
        ? "AUDIO_CONSOLE.Transport.Pause" : "AUDIO_CONSOLE.Transport.Play");
      // Foundry has no per-container pause, so in a mix this button could only pause one arbitrary
      // layer while the rest played on. Disabled rather than lying: Stop beside it still silences
      // everything, and the ambience section has its own Play All / Stop All pair.
      t.toggle.disabled = !has || state.mixed;
      t.toggle.setAttribute("aria-label", label);
      // Refreshed only if the bar asked for a tooltip in the first place. Writing it
      // unconditionally would re-add one to compact mode, whose template deliberately carries
      // none — the accessible label is separate and is always kept current.
      if ("tooltip" in t.toggle.dataset) t.toggle.dataset.tooltip = label;
      t.toggleIcon?.classList.toggle("fa-play", !state.playing);
      t.toggleIcon?.classList.toggle("fa-pause", state.playing);
    }

    // Previous/next walk a container's playback order, which a client-side preview Sound does not
    // have. Disabled rather than hidden, so the bar never reflows.
    // Nothing to skip to in a mix: every layer is already playing, and `advance` walks a running
    // order that a SIMULTANEOUS container does not have.
    const canSkip = (state.kind === "broadcast") && !!state.container && !state.mixed;
    if (t.previous) t.previous.disabled = !canSkip;
    if (t.next) t.next.disabled = !canSkip;
    if (t.stop) t.stop.disabled = !has;

    // Repeat is a track-list idea: a pad has its own loop in its config and an ambience layer its
    // own toggle on the row, and a preview Sound has no document to hold the setting.
    if (t.repeat) {
      const canRepeat = canSkip
        && [CONTAINER_KINDS.PLAYLIST, CONTAINER_KINDS.QUEUE].includes(containerKindOf(state.container));
      const on = canRepeat && !!state.sound.repeat;
      const label = game.i18n.localize(on ? "AUDIO_CONSOLE.Transport.RepeatOff" : "AUDIO_CONSOLE.Transport.Repeat");
      t.repeat.disabled = !canRepeat;
      t.repeat.classList.toggle("active", on);
      t.repeat.setAttribute("aria-pressed", String(on));
      t.repeat.setAttribute("aria-label", label);
      if ("tooltip" in t.repeat.dataset) t.repeat.dataset.tooltip = label;
    }

    const known = has && Number.isFinite(state.duration) && (state.duration > 0);
    // A drag in progress is the position, whatever the Sound is actually doing: the handle stays
    // under the pointer and the elapsed readout previews where letting go would land.
    const ratio = this.#seekRatio ?? (known ? Math.clamp(state.currentTime / state.duration, 0, 1) : 0);
    this.#paintProgress(ratio, state.duration, known);

    if (t.volume) {
      t.volume.disabled = !has || (state.volume === null);
      // The slider position is not the gain. Foundry maps between them so the control feels right
      // to the ear, and a linear mapping is never the substitute.
      const input = foundry.audio.AudioHelper.volumeToInput(state.volume ?? 0);
      if (document.activeElement !== t.volume) t.volume.value = String(input);
      t.volume.setAttribute("aria-valuetext", foundry.audio.AudioHelper.volumeToPercentage(input, { label: true }));
    }

    if (t.mode) {
      const key = state.live ? "Broadcast" : "Preview";
      const label = game.i18n.localize(`AUDIO_CONSOLE.Transport.Mode.${key}`);
      t.mode.classList.toggle("live", state.live);
      t.mode.setAttribute("aria-pressed", String(state.live));
      if ("tooltip" in t.mode.dataset) {
        t.mode.dataset.tooltip = game.i18n.localize(`AUDIO_CONSOLE.Transport.Mode.${key}Hint`);
      }
      // Text as well as colour and icon: the indicator has to survive a colour-blind GM and a
      // glance taken mid-sentence.
      if (t.modeLabel) t.modeLabel.textContent = label;
      t.modeIcon?.classList.toggle("fa-tower-broadcast", state.live);
      t.modeIcon?.classList.toggle("fa-headphones", !state.live);
    }

    this.#transportRoot.classList.toggle("playing", state.playing);
    if (state.playing) this.#startTick();
    else this.#stopTick();
  }

  /**
   * Write one position into every element that shows it — the fill, the handle, the ARIA state and
   * the elapsed/total readout — so a scrub and a live tick paint through exactly the same path and
   * cannot disagree about where the playhead is.
   * @param {number} ratio 0–1.
   * @param {number} duration Seconds; only meaningful when `known`.
   * @param {boolean} known Whether there is a real duration to seek within.
   */
  #paintProgress(ratio, duration, known) {
    const t = this.#transport;
    const percent = `${(ratio * 100).toFixed(2)}%`;
    if (t.fill) t.fill.style.width = percent;
    if (t.thumb) t.thumb.style.left = percent;
    // Duration comes free here and only here: the Sound is already loaded. The library table
    // deliberately has no duration column, because getting one there means decoding every file.
    const readout = known
      ? `${formatDuration(ratio * duration)} / ${formatDuration(duration)}` : "–:–– / –:––";
    if (t.time) t.time.textContent = readout;
    if (t.progress) {
      t.progress.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
      t.progress.setAttribute("aria-valuetext", known
        ? readout : game.i18n.localize("AUDIO_CONSOLE.Transport.Idle"));
      // aria-disabled rather than removing the control: the bar keeps its place in the layout and
      // in the tab order, and the CSS reads this one attribute to drop the handle and the pointer.
      t.progress.setAttribute("aria-disabled", known ? "false" : "true");
    }
  }

  #startTick() {
    this.#tickId ??= window.setInterval(() => this.updateTransport(), TICK_MS);
  }

  #stopTick() {
    if (this.#tickId !== null) window.clearInterval(this.#tickId);
    this.#tickId = null;
  }

  /* -------------------------------------------- */
  /*  Transport listeners and actions             */
  /* -------------------------------------------- */

  /**
   * A slider drag, applied the way core's own playlist directory applies it: the local source and
   * the audio node move immediately so the drag is audible without a round trip, and only the
   * database write is debounced. PlaylistSound#debounceVolume is that debounce — nothing here
   * hand-rolls one.
   */
  #onVolumeInput = event => {
    const state = this.#transportState();
    if (!state.sound) return;
    const volume = foundry.audio.AudioHelper.inputToVolume(Number(event.target.value));
    event.target.setAttribute("aria-valuetext",
      foundry.audio.AudioHelper.volumeToPercentage(Number(event.target.value), { label: true }));

    if (state.kind === "preview") {
      state.sound.volume = volume;
      return;
    }
    state.sound.updateSource({ volume });
    state.sound.sound?.fade(volume, { duration: foundry.documents.PlaylistSound.implementation.VOLUME_DEBOUNCE_MS });
    playback.setEntryVolume(state.sound, volume);
  };

  /* -------------------------------------------- */
  /*  Seeking                                     */
  /* -------------------------------------------- */

  /**
   * Where along the bar a pointer is, as 0–1. Read from the element's own box rather than from
   * offsetX so it stays right while the pointer is captured and has wandered outside the bar.
   * @param {HTMLElement} bar
   * @param {number} clientX
   * @returns {number}
   */
  static #ratioAt(bar, clientX) {
    const { left, width } = bar.getBoundingClientRect();
    return width > 0 ? Math.clamp((clientX - left) / width, 0, 1) : 0;
  }

  /** @returns {boolean} Whether there is a duration to seek within right now. */
  #canSeek() {
    return this.#transport.progress?.getAttribute("aria-disabled") === "false";
  }

  /**
   * Move the playhead of whatever the transport is controlling. Which path it takes is the same
   * decision #transportState already made, so seeking never crosses the preview/broadcast
   * interlock: a preview seek stays local, a broadcast seek is a document write every client
   * re-syncs from.
   * @param {number} seconds
   * @returns {Promise<void>}
   */
  async #seek(seconds) {
    const state = this.#transportState();
    if (!state.sound || !(state.duration > 0) || !Number.isFinite(seconds)) return;
    const target = Math.clamp(seconds, 0, state.duration);
    if (state.kind === "preview") await preview.seek(target);
    else await playback.seekEntry(state.container, state.sound, target);
    this.updateTransport();
  }

  /**
   * Pointer capture is what makes this a drag rather than a click: once the bar has the pointer,
   * move and up keep arriving here even when the pointer has left the 14px bar entirely, which is
   * exactly what a GM dragging quickly across a track does.
   */
  #onProgressPointerDown = event => {
    if ((event.button !== 0) || !this.#canSeek()) return;
    const bar = this.#transport.progress;
    // Stops the drag from turning into a text selection across the transport's own labels.
    event.preventDefault();
    bar.focus();
    bar.classList.add("seeking");
    bar.setPointerCapture(event.pointerId);
    this.#seekRatio = AudioConsoleApplication.#ratioAt(bar, event.clientX);
    this.updateTransport();
  };

  #onProgressPointerMove = event => {
    if (this.#seekRatio === null) return;
    this.#seekRatio = AudioConsoleApplication.#ratioAt(this.#transport.progress, event.clientX);
    this.updateTransport();
  };

  /**
   * Commit on release, never during the drag: a broadcast seek is two document writes that every
   * client re-syncs from, and firing that on every pointermove would be a stutter at the table.
   */
  #onProgressPointerUp = async event => {
    const ratio = this.#endDrag(event);
    if (ratio === null) return;
    const { duration } = this.#transportState();
    await this.#seek(ratio * duration);
  };

  /** A cancelled gesture is an abandoned one — the playhead goes back to where it really is. */
  #onProgressPointerCancel = event => {
    if (this.#endDrag(event) !== null) this.updateTransport();
  };

  /**
   * Release the drag, whichever way it ended.
   * @param {PointerEvent} event
   * @returns {number|null} The ratio it ended on, or null if no drag was in progress.
   */
  #endDrag(event) {
    if (this.#seekRatio === null) return null;
    const ratio = this.#seekRatio;
    this.#seekRatio = null;
    const bar = this.#transport.progress;
    bar?.classList.remove("seeking");
    if (bar?.hasPointerCapture(event.pointerId)) bar.releasePointerCapture(event.pointerId);
    return ratio;
  }

  /** The keyboard half of the slider: a GM's hands are busy, and this control restarts a track. */
  #onProgressKeydown = async event => {
    if (!this.#canSeek()) return;
    const state = this.#transportState();
    if (!(state.duration > 0)) return;
    let seconds;
    switch (event.key) {
      case "ArrowRight": case "ArrowUp": seconds = state.currentTime + SEEK_STEP_S; break;
      case "ArrowLeft": case "ArrowDown": seconds = state.currentTime - SEEK_STEP_S; break;
      case "PageUp": seconds = state.currentTime + SEEK_PAGE_S; break;
      case "PageDown": seconds = state.currentTime - SEEK_PAGE_S; break;
      case "Home": seconds = 0; break;
      case "End": seconds = state.duration; break;
      default: return;
    }
    event.preventDefault();
    await this.#seek(seconds);
  };

  /** @this {AudioConsoleApplication} */
  static async #onTransportToggle() {
    const state = this.#transportState();
    if (!state.sound) return;
    if (state.kind === "preview") {
      if (state.playing) await state.sound.pause();
      else await state.sound.play();
      this.updateTransport();
      return;
    }
    // Broadcast pause/resume is document state, not a local Sound: pausedTime on the document is
    // the truth and resuming is playSound() again (confirmed live).
    if (state.playing) await playback.pauseEntry(state.sound);
    else await playback.resumeEntry(state.container, state.sound);
  }

  /** @this {AudioConsoleApplication} */
  static async #onTransportPrevious() {
    const { container } = this.#transportState();
    if (container) await playback.advance(container, -1);
  }

  /** @this {AudioConsoleApplication} */
  static async #onTransportNext() {
    const { container } = this.#transportState();
    if (container) await playback.advance(container, 1);
  }

  /**
   * Stop everything on both paths, whichever mode is selected. This is the panic button; making
   * it mode-scoped would mean a GM in preview mode cannot silence the table with it.
   * @this {AudioConsoleApplication}
   */
  static async #onTransportStop() {
    await preview.stopAll();
    await playback.stopEverything();
    this.updateTransport();
  }

  /**
   * The native field, nothing of our own: PlaylistSound#repeat is Sound#loop, and a looping Sound
   * never ends, so the playlist never advances past it. The write echoes back through sync.js,
   * which is what repaints the button — read off the document here, not off the button.
   * @this {AudioConsoleApplication}
   */
  static async #onTransportRepeat() {
    const { kind, container, sound } = this.#transportState();
    if ((kind !== "broadcast") || !container || !sound) return;
    await updateEntries(container, [{ _id: sound.id, repeat: !sound.repeat }]);
  }

  /** @this {AudioConsoleApplication} */
  static async #onTransportMode() {
    await this.setAudioMode(this.isBroadcasting ? AUDIO_MODES.PREVIEW : AUDIO_MODES.BROADCAST);
  }
}
