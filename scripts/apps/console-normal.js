/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { AUDIO_MODES, AUTOMATION_CHANGED_HOOK, CHANNEL_ICONS, CHANNEL_LABEL_KEYS, CONTAINER_KINDS, DEFAULT_PAD_ICON, DISPLAY_MODES, MODULE_ID, PAD_VIEWS, PICKER_DRAG_TYPE, SETTINGS, SECTIONS, SOUND_DRAG_MARKER } from "../constants.js";
import { basenameOf, formatDuration, humanizeName, nextDefaultName, normalizePath } from "../helpers.js";
import { containerKindOf, getContainers, getEntries, getFavorites, getQueue, getSectionFolder, isContainer, isOn, isPaused } from "../data/repository.js";
import { buildContainerFlags, buildEntryFlags, readContainerFlags, readEntryFlags } from "../data/flag-models.js";
import {
  createContainers,
  createEntries,
  deleteContainers,
  deleteEntries,
  releaseContainers,
  updateContainers,
  updateEntries
} from "../data/mutations.js";
import * as library from "../library/index.js";
import * as playback from "../audio/playback.js";
import * as whisper from "../audio/whisper.js";
import { knownDuration, probeDuration } from "../audio/durations.js";
import { AudioConsoleApplication } from "./console-base.js";
import { AudioConsoleLibraryPicker } from "./library-picker.js";
import { LIBRARY_ACTIONS, LibrarySection } from "./library-section.js";
import { AUTOMATION_ACTIONS, bindRuleListDrag, prepareAutomationContext } from "./automation-section.js";
import { VirtualList } from "./virtual-list.js";
import {
  confirmClearQueue,
  confirmContainerDelete,
  promptBoardColor,
  promptContainerName,
  promptLayerPlayback,
  promptNewEntry,
  promptPadConfig,
  promptWhisperTarget
} from "./dialogs.js";

const TEMPLATES = `modules/${MODULE_ID}/templates/normal`;

// The parts that are a tab's contents, as opposed to the permanent furniture (rail, transport).
// Only one is ever on screen, so only one is ever built — see _configureRenderParts. Measured with
// a 1535-entry library and 1500-track containers: all eight parts are ~34,800 DOM nodes and ~800 ms
// per render; rail + library + transport alone are 866 nodes and ~280 ms.
const SECTION_PARTS = new Set(["library", "playlists", "soundboard", "ambience", "queue", "automation"]);

// How long the pointer rests on a pad before its tooltip appears. Core's own delay
// (TooltipManager.TOOLTIP_ACTIVATION_MS, 500 ms) is one static for the whole client, and it skips
// the wait entirely once any tooltip is showing — so sweeping across a board popped a tooltip on
// every pad passed over. The name is already on the face; the tooltip is only for a GM who stops
// to read the whole of it, or to learn about right-click.
const PAD_TOOLTIP_DELAY_MS = 1000;

/**
 * The three container sections, keyed by the SECTIONS value their buttons carry as
 * `data-section`. One table rather than one set of handlers per section: a Playlists card and an
 * Ambience card are created, selected, renamed and deleted by exactly the same code, and the only
 * things that differ are named here.
 *
 *   kind    the CONTAINER_KINDS value the section holds
 *   part    the PART that draws it (and the tab id, which is the same string)
 *   icon    the rail/favourites glyph
 *   i18n    the lang/en.json block its own strings live under
 *   toSpec  how a library row becomes an entry of this section — a mixing-desk layer loops by
 *           default, a track or a pad plays once
 */
const CONTAINER_SECTIONS = {
  [SECTIONS.PLAYLISTS]: {
    kind: CONTAINER_KINDS.PLAYLIST, part: "playlists", icon: "fa-solid fa-list-ol", i18n: "Playlists",
    toSpec: playback.soundSpecFor
  },
  [SECTIONS.SOUNDBOARDS]: {
    kind: CONTAINER_KINDS.SOUNDBOARD, part: "soundboard", icon: "fa-solid fa-grip", i18n: "Soundboard",
    toSpec: playback.soundSpecFor
  },
  [SECTIONS.AMBIENCES]: {
    kind: CONTAINER_KINDS.AMBIENCE, part: "ambience", icon: "fa-solid fa-sliders", i18n: "Ambience",
    toSpec: entry => ({ ...playback.soundSpecFor(entry), repeat: true })
  }
};

/** @type {Record<string, string>} CONTAINER_KINDS value -> SECTIONS key. */
const SECTION_OF_KIND = Object.fromEntries(
  Object.entries(CONTAINER_SECTIONS).map(([section, spec]) => [spec.kind, section])
);

/**
 * The section a container belongs to, from its own kind, so a favourite or a popout cannot point
 * at the wrong section even if the kind is changed underneath it.
 * @param {Playlist|null} container
 * @returns {{section: string, kind: string, part: string, icon: string, i18n: string, toSpec: Function}|null}
 */
function homeOf(container) {
  const section = SECTION_OF_KIND[containerKindOf(container)];
  return section ? { section, ...CONTAINER_SECTIONS[section] } : null;
}

/**
 * Paint a toggle's new state at the click, ahead of the write that confirms it. The document
 * only answers after a server round trip plus sync.js's debounce — half a second and more — which
 * is long enough that a GM presses the button a second time. So the button leads and the write
 * follows: the re-render either agrees, or the caller puts the old state back by hand.
 * @param {HTMLElement} target
 * @param {boolean} on
 */
function paintToggle(target, on) {
  target.classList.toggle("active", on);
  target.setAttribute("aria-pressed", String(on));
}

/**
 * paintToggle's counterpart for the playlist mode button, whose state is an icon and a word. Both
 * faces arrive on the element as `data-icon-on/off` and `data-label-on/off` from the template, so
 * the icon names and the localised words stay where every other string lives.
 * @param {HTMLElement} target
 * @param {boolean} shuffle
 */
function paintModeButton(target, shuffle) {
  const icon = target.querySelector("i");
  const label = target.querySelector("span");
  const { iconOn, iconOff, labelOn, labelOff } = target.dataset;
  if (!icon || !label || !iconOn || !iconOff) return;
  icon.className = shuffle ? iconOn : iconOff;
  label.textContent = shuffle ? labelOn : labelOff;
  target.setAttribute("aria-pressed", String(shuffle));
}

/**
 * Normal mode: the full management surface. The Library tab is a class of its own
 * (library-section.js); the three container sections share the handlers below through
 * CONTAINER_SECTIONS; the Automation section contributes its handlers from automation-section.js.
 */
export class AudioConsoleNormal extends AudioConsoleApplication {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-normal`,
    classes: [`${MODULE_ID}-normal`],
    window: {
      resizable: true
      // Compact mode is a header button (_renderFrame), not an entry in the controls menu: it is
      // the one switch a GM reaches for mid-session.
    },
    position: { width: 940, height: 640 },
    actions: {
      compactMode: AudioConsoleNormal.#onCompactMode,
      popOut: AudioConsoleNormal.#onPopOut,
      togglePopoutPlayback: AudioConsoleNormal.#onTogglePopoutPlayback,
      toggleFavorite: AudioConsoleNormal.#onToggleFavorite,
      openFavorite: AudioConsoleNormal.#onOpenFavorite,
      ...LIBRARY_ACTIONS,
      // Shared by the three container sections; every button carries `data-section`.
      createContainer: AudioConsoleNormal.#onCreateContainer,
      selectContainer: AudioConsoleNormal.#onSelectContainer,
      renameContainer: AudioConsoleNormal.#onRenameContainer,
      commitRenameContainer: AudioConsoleNormal.#onCommitRenameContainer,
      cancelRenameContainer: AudioConsoleNormal.#onCancelRenameContainer,
      deleteContainer: AudioConsoleNormal.#onDeleteContainer,
      playContainer: AudioConsoleNormal.#onPlayContainer,
      stopContainer: AudioConsoleNormal.#onStopContainer,
      addFileToContainer: AudioConsoleNormal.#onAddFileToContainer,
      addFromLibrary: AudioConsoleNormal.#onAddFromLibrary,
      addEntryToLibrary: AudioConsoleNormal.#onAddEntryToLibrary,
      removeContainerEntry: AudioConsoleNormal.#onRemoveContainerEntry,
      // Playlists
      togglePlaylistMode: AudioConsoleNormal.#onTogglePlaylistMode,
      playPlaylistEntry: AudioConsoleNormal.#onPlayPlaylistEntry,
      // Soundboard
      toggleDuck: AudioConsoleNormal.#onToggleDuck,
      boardColor: AudioConsoleNormal.#onBoardColor,
      togglePadView: AudioConsoleNormal.#onTogglePadView,
      configurePad: AudioConsoleNormal.#onConfigurePad,
      firePad: AudioConsoleNormal.#onFirePad,
      whisperPad: AudioConsoleNormal.#onWhisperPad,
      // Ambience
      toggleLayerLoop: AudioConsoleNormal.#onToggleLayerLoop,
      configureLayerPlayback: AudioConsoleNormal.#onConfigureLayerPlayback,
      // Now Playing
      playQueue: AudioConsoleNormal.#onPlayQueue,
      stopQueue: AudioConsoleNormal.#onStopQueue,
      clearQueue: AudioConsoleNormal.#onClearQueue,
      playQueueEntry: AudioConsoleNormal.#onPlayQueueEntry,
      removeQueueEntry: AudioConsoleNormal.#onRemoveQueueEntry,
      ...AUTOMATION_ACTIONS
    }
  };

  /**
   * The transport part comes last so it lands at the bottom of the grid (console-normal.css).
   * @override
   */
  static PARTS = {
    rail: { template: `${TEMPLATES}/rail.hbs` },
    library: { template: `${TEMPLATES}/library.hbs` },
    playlists: { template: `${TEMPLATES}/playlists.hbs` },
    soundboard: { template: `${TEMPLATES}/soundboard.hbs` },
    ambience: { template: `${TEMPLATES}/ambience.hbs` },
    queue: { template: `${TEMPLATES}/queue.hbs` },
    automation: { template: `${TEMPLATES}/automation.hbs` },
    transport: { template: `${TEMPLATES}/transport.hbs` }
  };

  /**
   * One tab per section. The part ids match the tab ids so _preparePartContext can hand each part
   * its own tab state. Now Playing and Automation sit last: neither is where a session starts.
   * @override
   */
  static TABS = {
    sections: {
      initial: "library",
      labelPrefix: "AUDIO_CONSOLE.Sections",
      tabs: [
        { id: "library", icon: "fa-solid fa-record-vinyl" },
        { id: "playlists", icon: CONTAINER_SECTIONS[SECTIONS.PLAYLISTS].icon },
        { id: "soundboard", icon: CONTAINER_SECTIONS[SECTIONS.SOUNDBOARDS].icon },
        { id: "ambience", icon: CONTAINER_SECTIONS[SECTIONS.AMBIENCES].icon },
        { id: "queue", icon: "fa-solid fa-bars-staggered" },
        { id: "automation", icon: "fa-solid fa-wand-magic-sparkles" }
      ]
    }
  };

  /** The Library tab. Public so LIBRARY_ACTIONS can reach it through `this`. */
  get librarySection() {
    return this.#library;
  }

  /** @type {LibrarySection} */
  #library = new LibrarySection(this);

  /**
   * The container whose name is being edited in place, by id, and the draft. One pair across all
   * three sections: only one field can be typed in, and a single value makes opening an edit here
   * cancel one left open behind another tab for free. Held on the instance because any document
   * or library change re-renders the window, which would otherwise discard a half-typed name.
   */
  #editingContainerId = null;
  #editDraft = "";

  /**
   * The container each section is showing, by SECTIONS key. Resolved — never merely read — by
   * #selectedIn(), so a stored id that no longer exists can never leave a section pointing at a
   * document that is gone.
   * @type {Record<string, string|null>}
   */
  #selected = {};

  /**
   * The selected playlist's rows and the selected board's pads, as view models. Held here rather
   * than in the render context because Handlebars never sees them: both lists are virtualised
   * (virtual-list.js), since a container filled from an imported library runs to thousands.
   */
  #playlistEntries = [];
  #pads = [];

  /** @type {VirtualList|null} */
  #entryList = null;

  /** @type {VirtualList|null} */
  #padList = null;

  /**
   * How many tiles share a row of the pad grid and how tall that row is, measured from the
   * grid's width by #fitPadGrid. #padList asks on every paint, so a window drag re-lays the grid.
   */
  #padMetrics = { columns: 0, rowHeight: 0 };

  /** Whether the selected board draws its pads as rows (PAD_VIEWS.LIST) rather than tiles. */
  #padListView = false;

  /** @type {number|null} The pending pad tooltip, from #onPadPointerEnter. */
  #padTooltipTimer = null;

  /** Watches the pad grid's width so the tiles can be resized to fill it. */
  #padGridObserver = null;

  #dragSoundId = null;
  #dragPadId = null;
  #dragRuleId = null;

  /** @type {number|null} Hook id for the automation engine's change notification. */
  #automationHookId = null;

  /**
   * Which section parts currently exist in the DOM — see #shouldRenderPart. Cleared on close,
   * because closing destroys the content element and everything in it.
   * @type {Set<string>}
   */
  #builtSections = new Set();

  /**
   * Set when this instance is a popout: a second, small window pinned to one container, showing
   * only that container's detail pane. A mode of this class rather than a class of its own,
   * because everything a section needs to draw and act on its container is a private member here.
   * @type {{containerId: string, kind: string, tab: string}|null}
   */
  #popout = null;

  /**
   * Reopen on the section the console was closed on. `_prepareTabs` reads
   * `this.tabGroups[group] ??= initial`, so a value put here before the first render wins and the
   * declared initial stays the fallback. A popout skips all of that: its section is the one that
   * owns the pinned container, and nothing it does is remembered.
   */
  constructor(options = {}) {
    super(options);
    const pinned = this.options.popout ? game.playlists.get(this.options.popout) : null;
    const home = homeOf(pinned);
    if (home) {
      this.#popout = { containerId: pinned.id, kind: home.kind, tab: home.part };
      this.tabGroups.sections = this.#popout.tab;
      return;
    }
    const saved = game.settings.get(MODULE_ID, SETTINGS.ACTIVE_SECTION);
    if (AudioConsoleNormal.TABS.sections.tabs.some(tab => tab.id === saved)) this.tabGroups.sections = saved;
  }

  /* -------------------------------------------- */
  /*  Popouts                                     */
  /* -------------------------------------------- */

  /**
   * Open (or bring forward) the popout for one container. One instance per container, keyed by
   * id. ApplicationV2 merges constructor options over DEFAULT_OPTIONS, concatenating `classes`
   * and deep-merging `window`, so the instance keeps every default except the ones named here.
   * @param {Playlist} container
   * @returns {AudioConsoleNormal|null} Null when the document is not one of this module's containers.
   */
  static openPopout(container) {
    const home = homeOf(container);
    if (!home) return null;
    const id = AudioConsoleNormal.#popoutId(container.id);
    const existing = foundry.applications.instances.get(id);
    if (existing) {
      existing.bringToFront();
      return existing;
    }
    const popout = new this({
      id,
      popout: container.id,
      classes: ["ac-popout"],
      window: { icon: home.icon },
      position: { width: 420, height: 320 }
    });
    popout.render({ force: true });
    return popout;
  }

  /** @param {string} containerId @returns {string} */
  static #popoutId(containerId) {
    return `${MODULE_ID}-popout-${containerId}`;
  }

  /**
   * Close the popout showing a container this console has just deleted or released. A deletion
   * would reach it through the document hook and _canRender anyway; a release would not — by the
   * time the update hook runs the flag that made the document ours is gone, so sync.js drops it.
   * @param {string} containerId
   */
  static #closePopout(containerId) {
    foundry.applications.instances.get(AudioConsoleNormal.#popoutId(containerId))?.close();
  }

  /** A popout is titled by the container it shows. @override */
  get title() {
    if (!this.#popout) return super.title;
    return game.playlists.get(this.#popout.containerId)?.name ?? super.title;
  }

  /**
   * A popout whose container is gone — deleted, or released back into a plain playlist — closes
   * instead of drawing an empty pane. Returning false is core's way of refusing a render.
   * @inheritDoc
   */
  _canRender(options) {
    super._canRender(options);
    if (!this.#popout) return;
    const container = game.playlists.get(this.#popout.containerId);
    if (containerKindOf(container) === this.#popout.kind) return;
    this.close();
    return false;
  }

  /** A popout cannot start a preview, so it must not silence the full console's on its way out. */
  get ownsPreview() {
    return !this.#popout;
  }

  /* -------------------------------------------- */
  /*  Lazily built section parts                  */
  /* -------------------------------------------- */

  /** @inheritDoc */
  changeTab(tab, group, options) {
    super.changeTab(tab, group, options);
    // After super: a tab that does not exist throws there, and a refused change must not be
    // remembered as if it had happened.
    if (group !== "sections") return;
    game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SECTION, tab);
    // First visit: the part was never built, so super's class toggle found nothing to activate.
    if (!this.#builtSections.has(tab)) return void this.render({ parts: [tab] });
    // Already built: a virtualised list repainted while its section was display:none measured a
    // clientHeight of 0 and painted its buffer rows only. It is visible now, so measure again.
    if (tab === "playlists") this.#entryList?.paint({ restoreScroll: true });
    if (tab === "soundboard") {
      const grid = this.element?.querySelector("[data-pad-grid]");
      if (grid) this.#fitPadGrid(grid);
    }
  }

  /**
   * The section the rail is on, resolved the way _prepareTabs resolves it — needed because
   * _configureRenderParts runs before _prepareTabs has filled `tabGroups.sections` in.
   * @returns {string}
   */
  get #activeSection() {
    return this.tabGroups.sections ?? AudioConsoleNormal.TABS.sections.initial;
  }

  /** @param {string} partId @returns {boolean} */
  #shouldRenderPart(partId) {
    if (this.#popout) return partId === this.#popout.tab;
    if (!SECTION_PARTS.has(partId)) return true;
    if (partId === this.#activeSection) return true;
    // An already-built section still redraws: it is in the DOM and a GM can tab back to it.
    if (this.#builtSections.has(partId)) return true;
    // A part named by a caller but never built is not an exception: the renderers that name
    // parts are saying "this is out of date", and a section nobody has opened cannot be.
    return false;
  }

  /** Build only the rail, the transport, and the one section on screen. @inheritDoc */
  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    for (const partId of Object.keys(parts)) {
      if (!this.#shouldRenderPart(partId)) delete parts[partId];
    }
    return parts;
  }

  /**
   * Drop the skipped parts from an explicit `parts` list too, or the mixin's _renderHTML would
   * warn about an unsupported part, and _prepareContext would build a slice for nothing.
   * @inheritDoc
   */
  _configureRenderOptions(options) {
    super._configureRenderOptions(options);
    options.parts = options.parts.filter(partId => this.#shouldRenderPart(partId));
    // Core only writes the frame title on the first render; a popout's container can be renamed
    // from the full console while it is open, so the title rides along with every render.
    if (this.#popout && this.hasFrame) {
      options.window ??= {};
      options.window.title = this.title;
    }
  }

  /* -------------------------------------------- */
  /*  Container selection                          */
  /* -------------------------------------------- */

  /** @returns {Record<string, string>} The last container opened in each section, by section key. */
  #lastSelectedContainers() {
    return game.settings.get(MODULE_ID, SETTINGS.SELECTED_CONTAINERS) ?? {};
  }

  /**
   * Point one section at a container and remember it, so the next open lands there.
   * @param {string} section A SECTIONS key.
   * @param {string|null} id
   */
  #selectContainer(section, id) {
    this.#selected[section] = id;
    if (!id) return;
    game.settings.set(MODULE_ID, SETTINGS.SELECTED_CONTAINERS, { ...this.#lastSelectedContainers(), [section]: id });
    // An open "Add from Library" window works on whatever the GM last picked here, so its
    // "Add Selected" never points somewhere other than the container on screen.
    AudioConsoleLibraryPicker.retarget(game.playlists.get(id));
  }

  /**
   * Which container a section is showing — resolved, not merely read: the stored id, else the one
   * the GM last had open there, else the first in the list. Written back so the card list's
   * `active` flag and every handler agree with what the detail pane is actually showing.
   * @param {string} section A SECTIONS key.
   * @returns {Playlist|null} Null only when the section genuinely has no containers.
   */
  #selectedIn(section) {
    const { kind } = CONTAINER_SECTIONS[section];
    let container = null;
    if (this.#popout) {
      // Pinned: never re-resolved to a neighbour. A container that has stopped being one of this
      // kind is null here, and _canRender closes the window on it.
      const pinned = game.playlists.get(this.#popout.containerId);
      container = containerKindOf(pinned) === kind ? pinned : null;
    } else {
      const containers = getContainers(kind);
      container = containers.find(c => c.id === this.#selected[section])
        ?? containers.find(c => c.id === this.#lastSelectedContainers()[section])
        ?? containers[0] ?? null;
    }
    this.#selected[section] = container?.id ?? null;
    return container;
  }

  /**
   * The section a button belongs to, and the container it has open. Handlers read the section off
   * the button rather than a container id baked into the markup: an id is only as fresh as the
   * last render, and a click that lands before a selection change has repainted would act on
   * whatever was open a moment ago.
   * @param {HTMLElement} target
   * @returns {{section: string, spec: object, container: Playlist|null}}
   */
  #sectionOf(target) {
    const section = target.dataset.section;
    const spec = CONTAINER_SECTIONS[section];
    if (!spec) throw new Error(`${MODULE_ID} | "${section}" is not a container section`);
    return { section, spec, container: this.#selectedIn(section) };
  }

  /* -------------------------------------------- */
  /*  Favorites                                    */
  /* -------------------------------------------- */

  /**
   * Pin the container a section currently has open, or unpin it. A flag write, so every open
   * console redraws through the ordinary document hook.
   * @this {AudioConsoleNormal}
   */
  static async #onToggleFavorite(event, target) {
    const { container } = this.#sectionOf(target);
    if (!isContainer(container)) return;
    const flags = readContainerFlags(container);
    // Spread first: a flag write replaces the whole scope, so omitting `kind` would reset the
    // container to a plain playlist.
    await updateContainers([{
      _id: container.id,
      flags: { [MODULE_ID]: buildContainerFlags({ ...flags, favorite: !flags.favorite }) }
    }]);
  }

  /**
   * Jump to a favourite: open the section that holds it and select it there.
   * @this {AudioConsoleNormal}
   */
  static async #onOpenFavorite(event, target) {
    const container = game.playlists.get(target.dataset.containerId);
    const home = homeOf(container);
    if (!home) return;
    this.#selectContainer(home.section, container.id);
    // Read before changeTab, which flips it: on a first visit the tab change builds the part
    // itself, already carrying the selection, and naming it here too would render it twice.
    const built = this.#builtSections.has(home.part);
    this.changeTab(home.part, "sections");
    await this.render({ parts: built ? [home.part, "rail"] : ["rail"] });
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /**
   * The two fields every container card needs to render itself mid-rename.
   * @param {Playlist} container
   * @returns {{editing: boolean, draft: string}}
   */
  #renameState(container) {
    const editing = container.id === this.#editingContainerId;
    return { editing, draft: editing ? this.#editDraft : container.name };
  }

  /**
   * The shared context, plus one slice per part actually being rendered. With 1500-entry
   * containers the three container slices are ~160 ms of object building, so only the parts the
   * renderer is about to draw get one — `options.parts` is already narrowed at this point.
   * @inheritDoc
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const parts = new Set(options.parts);
    // The templates drop the container list and the management controls on this.
    context.popout = !!this.#popout;

    // The rail is always rendered, and lists the favourites with the icon of their section.
    context.favorites = getFavorites().map(container => ({
      id: container.id,
      name: container.name,
      icon: homeOf(container)?.icon ?? "fa-solid fa-star"
    }));

    if (parts.has("library")) this.#library.prepareContext(context);
    if (parts.has("playlists")) this.#preparePlaylistsContext(context);
    if (parts.has("soundboard")) this.#prepareSoundboardContext(context);
    if (parts.has("ambience")) this.#prepareAmbienceContext(context);
    if (parts.has("queue")) this.#prepareQueueContext(context);
    // Namespaced: automation carries a `log` and a `rules`, words any later section could want.
    if (parts.has("automation")) context.automation = prepareAutomationContext();
    return context;
  }

  /**
   * The card list every container section draws on its left.
   * @param {string} section A SECTIONS key.
   * @param {Playlist|null} selected
   * @returns {object[]}
   */
  #containerCards(section, selected) {
    return getContainers(CONTAINER_SECTIONS[section].kind).map(container => ({
      id: container.id,
      name: container.name,
      playing: isOn(container),
      active: container.id === selected?.id,
      ...this.#renameState(container)
    }));
  }

  /** @param {object} context */
  #preparePlaylistsContext(context) {
    const modes = foundry.CONST.PLAYLIST_MODES;
    const modeLabel = mode => mode === modes.SHUFFLE
      ? "AUDIO_CONSOLE.Playlists.Mode.Shuffle" : "AUDIO_CONSOLE.Playlists.Mode.Sequential";
    const selected = this.#selectedIn(SECTIONS.PLAYLISTS);
    context.containers = this.#containerCards(SECTIONS.PLAYLISTS, selected);
    // The rows go on the instance: the list is virtualised, so the template renders an empty
    // window and #renderEntryRows paints a screenful of these.
    this.#playlistEntries = selected ? getEntries(selected).map(sound => {
      const entry = library.getEntry(sound.path);
      return {
        id: sound.id,
        path: sound.path,
        name: entry?.name || sound.name || humanizeName(basenameOf(sound.path)),
        // Whatever has been read this session; the rest is filled in after each paint.
        duration: formatDuration(knownDuration(sound.path)),
        hasLibraryEntry: !!entry,
        playing: sound.playing
      };
    }) : [];
    context.selectedContainer = selected ? {
      id: selected.id,
      name: selected.name,
      favorite: readContainerFlags(selected).favorite,
      playing: selected.playing,
      fade: selected.fade ?? "",
      shuffle: selected.mode === modes.SHUFFLE,
      modeLabel: modeLabel(selected.mode)
    } : null;
  }

  /** @param {object} context */
  #prepareSoundboardContext(context) {
    const selected = this.#selectedIn(SECTIONS.SOUNDBOARDS);
    context.soundboards = this.#containerCards(SECTIONS.SOUNDBOARDS, selected);
    this.#pads = selected ? getEntries(selected).map(sound => {
      const entry = library.getEntry(sound.path);
      const flags = readEntryFlags(sound);
      return {
        id: sound.id,
        name: flags.label || entry?.name || sound.name || humanizeName(basenameOf(sound.path)),
        hasLibraryEntry: !!entry,
        playing: sound.playing,
        color: flags.color,
        // The pad face is never null: the default is resolved here rather than in the template.
        icon: flags.icon || DEFAULT_PAD_ICON,
        randomLabel: flags.random.enabled ? `${flags.random.interval}s` : null
      };
    }) : [];
    const flags = selected ? readContainerFlags(selected) : null;
    this.#padListView = flags?.view === PAD_VIEWS.LIST;
    context.selectedSoundboard = selected ? {
      id: selected.id,
      name: selected.name,
      favorite: flags.favorite,
      duck: flags.duck,
      color: flags.color,
      listView: this.#padListView,
      viewToggleLabel: this.#padListView
        ? "AUDIO_CONSOLE.Soundboard.Actions.ViewGrid" : "AUDIO_CONSOLE.Soundboard.Actions.ViewList"
    } : null;
  }

  /** @param {object} context */
  #prepareAmbienceContext(context) {
    const selected = this.#selectedIn(SECTIONS.AMBIENCES);
    context.ambiences = this.#containerCards(SECTIONS.AMBIENCES, selected);
    context.selectedAmbience = selected ? {
      id: selected.id,
      name: selected.name,
      favorite: readContainerFlags(selected).favorite,
      playing: isOn(selected),
      fade: selected.fade ?? "",
      layers: getEntries(selected).map(sound => {
        const entry = library.getEntry(sound.path);
        const flags = readEntryFlags(sound);
        const volumeInput = foundry.audio.AudioHelper.volumeToInput(sound.volume);
        return {
          id: sound.id,
          name: entry?.name || sound.name || humanizeName(basenameOf(sound.path)),
          // The channel is a read-only indicator here: a layer carries the channel it was
          // created with. The tags are a tooltip away.
          channelIcon: entry ? CHANNEL_ICONS[entry.channel] : null,
          channelLabel: entry ? game.i18n.localize(CHANNEL_LABEL_KEYS[entry.channel]) : null,
          tagsLabel: (entry?.tags ?? []).join(", "),
          hasLibraryEntry: !!entry,
          playing: sound.playing,
          loop: sound.repeat,
          volumeInput,
          volumeLabel: foundry.audio.AudioHelper.volumeToPercentage(volumeInput, { label: true }),
          randomLabel: flags.random.enabled ? `${flags.random.interval}s` : null,
          randomOnStart: flags.random.enabled && flags.random.onStart
        };
      })
    } : null;
  }

  /**
   * The Now Playing queue. Nothing to select — bootstrap guarantees exactly one — and `null` only
   * means a GM deleted it out from under the module in the native sidebar.
   * @param {object} context
   */
  #prepareQueueContext(context) {
    const queue = getQueue();
    context.queue = queue ? {
      id: queue.id,
      name: queue.name,
      playing: queue.playing,
      count: queue.sounds.size,
      entries: getEntries(queue).map(sound => {
        const entry = library.getEntry(sound.path);
        const volumeInput = foundry.audio.AudioHelper.volumeToInput(sound.volume);
        return {
          id: sound.id,
          name: entry?.name || sound.name || humanizeName(basenameOf(sound.path)),
          playing: sound.playing,
          volumeInput,
          volumeLabel: foundry.audio.AudioHelper.volumeToPercentage(volumeInput, { label: true }),
          paused: isPaused(sound)
        };
      })
    } : null;
  }

  /** The Handlebars mixin does not assign tab state to parts, so each part picks up its own. @inheritDoc */
  async _preparePartContext(partId, context, options) {
    const partContext = await super._preparePartContext(partId, context, options);
    partContext.tab = partContext.tabs?.[partId];
    return partContext;
  }

  /* -------------------------------------------- */
  /*  Frame                                       */
  /* -------------------------------------------- */

  /**
   * Put Compact mode in the window header, immediately left of the controls ellipsis. Not
   * `_getFrameButtons()`: core renders an icon-only button after the ellipsis, and this one needs
   * its label spelled out and needs to sit before it. `.header-control` is load-bearing:
   * ApplicationV2's header drag handler bails on it, so pressing the button does not drag the
   * window. The click needs no listener — `data-action` is served by the frame's delegation.
   * @inheritDoc
   */
  async _renderFrame(options) {
    const frame = await super._renderFrame(options);
    const controls = frame.querySelector("[data-action=toggleControls]");
    if (!controls) return frame;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "header-control ac-header-button";
    if (this.#popout) {
      // A popout has no display mode to switch. Its header carries the one control the pane has
      // no room for — Play/Stop of the whole container. A soundboard gets nothing: a board is not
      // played as a whole.
      if (this.#popout.kind === CONTAINER_KINDS.SOUNDBOARD) return frame;
      button.dataset.action = "togglePopoutPlayback";
      button.dataset.popoutToggle = "";
      button.innerHTML = `<i inert></i><span inert></span>`;
      controls.before(button);
      return frame;
    }
    const label = game.i18n.localize("AUDIO_CONSOLE.Controls.Compact");
    button.dataset.action = "compactMode";
    button.setAttribute("aria-label", label);
    button.innerHTML = `<i class="fa-solid fa-compress" inert></i><span inert>${foundry.utils.escapeHTML(label)}</span>`;
    controls.before(button);
    return frame;
  }

  /** Paint the popout header's Play/Stop from the container's state — a direct DOM write. */
  #paintPopoutToggle() {
    const button = this.element?.querySelector("[data-popout-toggle]");
    if (!button || !this.#popout) return;
    const playing = isOn(game.playlists.get(this.#popout.containerId));
    const ambience = this.#popout.kind === CONTAINER_KINDS.AMBIENCE;
    const label = game.i18n.localize(playing
      ? (ambience ? "AUDIO_CONSOLE.Ambience.Actions.StopAll" : "AUDIO_CONSOLE.Playlists.Actions.Stop")
      : (ambience ? "AUDIO_CONSOLE.Ambience.Actions.PlayAll" : "AUDIO_CONSOLE.Playlists.Actions.Play"));
    button.querySelector("i").className = playing ? "fa-solid fa-stop" : "fa-solid fa-play";
    button.querySelector("span").textContent = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(playing));
  }

  /** @this {AudioConsoleNormal} */
  static async #onTogglePopoutPlayback() {
    const container = this.#popout ? game.playlists.get(this.#popout.containerId) : null;
    if (!container) return;
    if (isOn(container)) return void await playback.stopContainer(container);
    await this.setAudioMode(AUDIO_MODES.BROADCAST);
    await playback.playContainer(container);
  }

  /** @this {AudioConsoleNormal} */
  static async #onCompactMode() {
    await this.switchDisplayMode(DISPLAY_MODES.COMPACT);
  }

  /** @this {AudioConsoleNormal} */
  static #onPopOut(event, target) {
    const { container } = this.#sectionOf(target);
    if (container) AudioConsoleNormal.openPopout(container);
  }

  /* -------------------------------------------- */
  /*  Render                                      */
  /* -------------------------------------------- */

  /**
   * The Library is always in the list: its table body is repainted imperatively by its own
   * onRender, so naming the part is what makes that repaint run. Everything else redraws only if
   * it is currently showing one of the changed paths, and a section never opened is not asked at
   * all — walking a 1500-track container to decide whether to redraw something not in the DOM is
   * the cost this class spends the rest of its render path avoiding.
   * @inheritDoc
   */
  renderForLibraryChange(change) {
    // A null path set is a change too broad to enumerate: everything is stale.
    if (!change?.paths) return void this.render();
    const parts = ["library"];
    const showsAChangedPath = (part, container) => this.#builtSections.has(part) && !!container
      && getEntries(container).some(sound => change.paths.has(normalizePath(sound.path)));
    for (const [section, spec] of Object.entries(CONTAINER_SECTIONS)) {
      if (showsAChangedPath(spec.part, this.#selectedIn(section))) parts.push(spec.part);
    }
    if (showsAChangedPath("queue", getQueue())) parts.push("queue");
    this.render({ parts });
  }

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    // Record what is now in the DOM before anything below reads it.
    for (const partId of options.parts ?? []) {
      if (SECTION_PARTS.has(partId)) this.#builtSections.add(partId);
    }

    this.#library.onRender(options);

    this.element.querySelector("[data-playlist-fade]")?.addEventListener("change", this.#onFadeChange);
    this.element.querySelector("[data-ambience-fade]")?.addEventListener("change", this.#onFadeChange);
    // querySelectorAll: Playlists and Now Playing both have an entry list, and once both have been
    // visited both are in the DOM. Which container a drop lands in comes off the list's own
    // data-container-id (#containerForList), so the handlers stay shared. The listeners are stable
    // arrow fields, so re-adding one to an element that survived a partial render is a no-op.
    for (const entryList of this.element.querySelectorAll("[data-entry-list]")) {
      entryList.addEventListener("dragstart", this.#onEntryDragStart);
      entryList.addEventListener("dragover", this.#onEntryDragOver);
      entryList.addEventListener("dragleave", this.#onEntryDragLeave);
      entryList.addEventListener("drop", this.#onEntryDrop);
      entryList.addEventListener("dragend", this.#onEntryDragEnd);
      entryList.addEventListener("input", this.#onEntryVolumeInput);
    }
    this.element.querySelector("[data-layer-list]")?.addEventListener("input", this.#onEntryVolumeInput);
    for (const list of this.element.querySelectorAll("[data-container-drop]")) {
      list.addEventListener("dragover", this.#onContainerListDragOver);
      list.addEventListener("dragleave", this.#onContainerListDragLeave);
      list.addEventListener("drop", this.#onContainerListDrop);
    }

    // Right-click opens pad config; reordering is delegated on the grid because, virtualised, the
    // tile a drag starts on may not have existed a scroll frame ago.
    const padGrid = this.element.querySelector("[data-pad-grid]");
    padGrid?.addEventListener("contextmenu", this.#onPadContextMenu);
    // pointerenter/leave do not bubble, so they are caught on the way down — the same capture
    // core's own TooltipManager listens with.
    padGrid?.addEventListener("pointerenter", this.#onPadPointerEnter, true);
    padGrid?.addEventListener("pointerleave", this.#onPadPointerLeave, true);
    padGrid?.addEventListener("pointerdown", this.#cancelPadTooltip, true);
    padGrid?.addEventListener("dragstart", this.#onPadDragStart);
    padGrid?.addEventListener("dragover", this.#onPadDragOver);
    padGrid?.addEventListener("dragleave", this.#onPadDragLeave);
    padGrid?.addEventListener("drop", this.#onPadDrop);
    padGrid?.addEventListener("dragend", this.#onPadDragEnd);

    // Both virtual lists paint here, and only when their part actually rendered: repainting them
    // for another section's redraw would throw away the GM's scroll position for nothing.
    const renderedContainers = !options.parts
      || options.parts.includes("playlists") || options.parts.includes("soundboard");
    if (renderedContainers) {
      this.#bindContainerLists({ resetScroll: false, measurePadGrid: !options.isFirstRender });
    }

    // The rename field, when a card is mid-edit. Selected, not merely focused: a rename usually
    // replaces the name. Bound only when its part rendered, so a redraw of another section does
    // not stack a second listener on a field that survived it.
    const renameInput = this.element.querySelector("[data-rename-input]");
    const renamePart = renameInput?.closest("[data-tab]")?.dataset.tab;
    if (renameInput && (!options.parts || options.parts.includes(renamePart))) {
      renameInput.addEventListener("input", this.#onRenameInput);
      renameInput.addEventListener("keydown", this.#onRenameKeydown);
      renameInput.focus();
      renameInput.select();
    }

    this.#fillDurations();
    this.#paintPopoutToggle();

    // bindRuleListDrag builds fresh closures, so it is bound only when the list re-rendered;
    // binding it again on an untouched list would move a dropped rule twice.
    const renderedAutomation = !options.parts || options.parts.includes("automation");
    const ruleList = renderedAutomation ? this.element.querySelector("[data-rule-list]") : null;
    if (ruleList) {
      bindRuleListDrag(ruleList, {
        get: () => this.#dragRuleId,
        set: id => { this.#dragRuleId = id; }
      });
    }

    // The engine holds state this window draws but does not own. Subscribed here rather than in
    // _onFirstRender so a window closed and reopened comes back listening.
    if (this.#automationHookId === null) {
      this.#automationHookId = foundry.helpers.Hooks.on(AUTOMATION_CHANGED_HOOK, () => {
        if (this.rendered) this.render({ parts: ["automation"] });
      });
    }
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    this.#library.onClose();
    this.#padGridObserver?.disconnect();
    this.#padGridObserver = null;
    this.#cancelPadTooltip();
    if (this.#automationHookId !== null) {
      foundry.helpers.Hooks.off(AUTOMATION_CHANGED_HOOK, this.#automationHookId);
    }
    this.#automationHookId = null;
    this.#dragRuleId = null;
    this.#entryList?.destroy();
    this.#entryList = null;
    this.#padList?.destroy();
    this.#padList = null;
    this.#playlistEntries = [];
    this.#pads = [];
    this.#padMetrics = { columns: 0, rowHeight: 0 };
    // Closing destroys the content element, so every section part goes with it.
    this.#builtSections.clear();
  }

  /* -------------------------------------------- */
  /*  Keeping the drawn state true without a render */
  /* -------------------------------------------- */

  /**
   * The base updates the transport on every playback change and on its own tick; every
   * playing/paused face in this window rides the same signal, for the same reason. A start or a
   * stop is a playback change (data/sync.js) and never renders, so what the rows show is written
   * straight into them here.
   * @inheritDoc
   */
  updateTransport() {
    super.updateTransport();
    this.#paintQueueState();
    this.#paintPadState();
    this.#paintContainerState();
    this.#paintPopoutToggle();
  }

  /**
   * The Now Playing rows: the three things that can change, written only when they differ.
   */
  #paintQueueState() {
    const list = this.element?.querySelector("[data-queue-list]");
    const queue = list ? getQueue() : null;
    if (!queue) return;
    const labels = {
      play: game.i18n.localize("AUDIO_CONSOLE.Queue.Actions.PlayEntry"),
      pause: game.i18n.localize("AUDIO_CONSOLE.Transport.Pause"),
      paused: game.i18n.localize("AUDIO_CONSOLE.Queue.Paused")
    };
    for (const row of list.querySelectorAll("[data-sound-id]")) {
      const sound = queue.sounds.get(row.dataset.soundId);
      if (!sound) continue;
      const playing = !!sound.playing;
      const paused = isPaused(sound);
      if ((row.classList.contains("playing") === playing)
        && (row.classList.contains("paused") === paused)) continue;
      row.classList.toggle("playing", playing);
      row.classList.toggle("paused", paused);

      const button = row.querySelector('[data-action="playQueueEntry"]');
      if (button) {
        const label = playing ? labels.pause : labels.play;
        button.setAttribute("aria-label", label);
        button.dataset.tooltip = label;
        const icon = button.querySelector("i");
        icon?.classList.toggle("fa-pause", playing);
        icon?.classList.toggle("fa-play", !playing);
      }

      // Added and removed rather than hidden, so a screen reader announces exactly what shows.
      const state = row.querySelector(".ac-entry-state");
      if (paused && !state) {
        const el = document.createElement("span");
        el.className = "ac-entry-state";
        el.textContent = labels.paused;
        row.querySelector(".ac-entry-name")?.after(el);
      } else if (!paused) state?.remove();
    }
  }

  /** Each pad's `playing` face, true to its document. */
  #paintPadState() {
    const grid = this.element?.querySelector("[data-pad-grid]");
    const board = grid ? this.#selectedIn(SECTIONS.SOUNDBOARDS) : null;
    if (!board) return;
    const labels = {
      fire: game.i18n.localize("AUDIO_CONSOLE.Soundboard.Actions.Fire"),
      stop: game.i18n.localize("AUDIO_CONSOLE.Soundboard.Actions.Stop")
    };
    for (const pad of grid.querySelectorAll(".ac-pad[data-sound-id]")) {
      const sound = board.sounds.get(pad.dataset.soundId);
      if (!sound) continue;
      const playing = !!sound.playing;
      if (pad.classList.contains("playing") === playing) continue;
      pad.classList.toggle("playing", playing);
      // The name the face shows, which a pad's own label may have replaced — not sound.name.
      const name = this.#pads.find(p => p.id === sound.id)?.name ?? sound.name;
      pad.querySelector(".ac-pad-fire")?.setAttribute("aria-label", `${playing ? labels.stop : labels.fire}: ${name}`);
    }
  }

  /**
   * Everything else in the container sections that shows a playing state: the card list's
   * speaker icon, the header's Play/Stop pair, the playlist entry rows and the ambience layers.
   */
  #paintContainerState() {
    const element = this.element;
    if (!element) return;

    for (const card of element.querySelectorAll(".ac-container-card[data-container-id]")) {
      const container = game.playlists.get(card.dataset.containerId);
      // Soundboards never show one: a board is never "playing" as a whole.
      const playing = isOn(container) && (containerKindOf(container) !== CONTAINER_KINDS.SOUNDBOARD);
      const icon = card.querySelector(".ac-container-playing");
      if (playing && !icon) {
        const el = document.createElement("i");
        el.className = "fa-solid fa-volume-high ac-container-playing";
        el.inert = true;
        card.append(el);
      } else if (!playing) icon?.remove();
    }

    for (const button of element.querySelectorAll("[data-playback-toggle][data-section]")) {
      const container = this.#selectedIn(button.dataset.section);
      const playing = isOn(container);
      button.hidden = (button.dataset.playbackToggle === "play") ? playing : !playing;
    }

    for (const list of element.querySelectorAll("[data-entry-list]:not([data-queue-list])")) {
      const container = game.playlists.get(list.dataset.containerId);
      if (!container) continue;
      for (const row of list.querySelectorAll(".ac-entry[data-sound-id]")) {
        const playing = !!container.sounds.get(row.dataset.soundId)?.playing;
        if (row.classList.contains("playing") === playing) continue;
        row.classList.toggle("playing", playing);
        const icon = row.querySelector('[data-action="playPlaylistEntry"] i');
        icon?.classList.toggle("fa-volume-high", playing);
        icon?.classList.toggle("fa-play", !playing);
      }
    }

    const layerList = element.querySelector("[data-layer-list]");
    const ambience = layerList ? game.playlists.get(layerList.dataset.containerId) : null;
    if (ambience) {
      for (const row of layerList.querySelectorAll(".ac-layer[data-sound-id]")) {
        row.classList.toggle("playing", !!ambience.sounds.get(row.dataset.soundId)?.playing);
      }
    }
  }

  /* -------------------------------------------- */
  /*  The pad grid                                */
  /* -------------------------------------------- */

  /**
   * Watch the scroller's width so the pads can be resized to fill it. The scroller, never the
   * grid: once the grid became a virtual window its height is a product of what was just painted,
   * so observing it meant every paint scheduled another callback.
   * @param {HTMLElement|null} grid
   */
  #watchPadGrid(grid) {
    this.#padGridObserver?.disconnect();
    this.#padGridObserver = null;
    if (!grid) return;
    const scroll = grid.closest("[data-pad-scroll]");
    if (!scroll) return;
    this.#padGridObserver = new ResizeObserver(() => this.#fitPadGrid(grid));
    // ResizeObserver fires once on observe, which is also the initial sizing.
    this.#padGridObserver.observe(scroll);
  }

  /**
   * Measure the grid and write back both the tile size and the column count, then repaint.
   *
   * CSS cannot express this: square tiles need the row height to follow the column width, and
   * `aspect-ratio` cannot do that inside a grid whose columns are flexible. The column count is
   * written explicitly because virtual-list.js turns a scroll offset into a row index, and a row
   * it thinks holds five tiles while the browser lays out six is a spacer of the wrong height.
   * @param {HTMLElement} grid
   */
  #fitPadGrid(grid) {
    const scroll = grid.closest("[data-pad-scroll]");
    if (!scroll) return;
    const styles = getComputedStyle(grid);
    const scrollStyles = getComputedStyle(scroll);
    // A list is one column of fixed-height rows, which the stylesheet owns (--ac-pad-row-height)
    // the same way it owns --ac-entry-height for the playlist rows.
    if (this.#padListView) {
      const rowHeight = parseFloat(styles.getPropertyValue("--ac-pad-row-height"));
      if (!(rowHeight > 0)) return;
      grid.style.setProperty("--ac-pad-columns", "1");
      this.#padMetrics = { columns: 1, rowHeight: rowHeight + parseFloat(styles.rowGap) };
      this.#padList?.paint({ restoreScroll: true });
      return;
    }
    const min = parseFloat(styles.getPropertyValue("--ac-pad-min"));
    const gap = parseFloat(styles.columnGap);
    // clientWidth already excludes the scrollbar, and .ac-pad-scroll reserves that gutter
    // permanently so a board that grows past one screenful cannot start a resize loop.
    const width = scroll.clientWidth
      - parseFloat(scrollStyles.paddingLeft) - parseFloat(scrollStyles.paddingRight);
    if (!(width > 0) || !(min > 0)) return;
    const columns = Math.max(1, Math.floor((width + gap) / (min + gap)));
    // Floor: a fractional pixel per tile times the column count pushes the last one onto its own row.
    const size = Math.floor((width - (gap * (columns - 1))) / columns);
    grid.style.setProperty("--ac-pad-size", `${size}px`);
    grid.style.setProperty("--ac-pad-columns", `${columns}`);
    this.#padMetrics = { columns, rowHeight: size + gap };
    this.#padList?.paint({ restoreScroll: true });
  }

  /* -------------------------------------------- */
  /*  The virtualised container lists             */
  /* -------------------------------------------- */

  /**
   * The rows of the Playlists section's entry list, as one HTML string — this runs on every
   * scroll frame, and one innerHTML write beats appendChild in a loop.
   * @param {number} start
   * @param {number} end
   * @returns {string}
   */
  #renderEntryRows(start, end) {
    const e = foundry.utils.escapeHTML;
    const labels = {
      drag: game.i18n.localize("AUDIO_CONSOLE.Playlists.DragHint"),
      play: game.i18n.localize("AUDIO_CONSOLE.Playlists.Actions.PlayEntry"),
      remove: game.i18n.localize("AUDIO_CONSOLE.Playlists.Actions.RemoveEntry"),
      addToLibrary: game.i18n.localize("AUDIO_CONSOLE.Playlists.Actions.AddToLibrary"),
      volume: game.i18n.localize("AUDIO_CONSOLE.Containers.EntryVolume")
    };
    // Volume comes off the document at paint time: a volume write is playback-only and never
    // re-renders, so a value captured at prepareContext would come back stale on the next scroll.
    const container = this.#selectedIn(SECTIONS.PLAYLISTS);
    const html = [];
    for (let index = start; index < end; index++) {
      const entry = this.#playlistEntries[index];
      if (!entry) continue;
      const id = e(entry.id);
      const name = e(entry.name);
      const volumeInput = foundry.audio.AudioHelper.volumeToInput(container?.sounds.get(entry.id)?.volume ?? 0);
      const volumeLabel = foundry.audio.AudioHelper.volumeToPercentage(volumeInput, { label: true });
      const addButton = entry.hasLibraryEntry ? "" : `<button type="button" class="ac-button ac-button-quiet ac-entry-add-library" data-action="addEntryToLibrary" data-section="${SECTIONS.PLAYLISTS}" data-sound-id="${id}">${e(labels.addToLibrary)}</button>`;
      // The name plays too, so the whole line is a target; the button stays as the affordance
      // and as the focusable one.
      html.push(`<li class="ac-entry${entry.playing ? " playing" : ""}" draggable="true" data-sound-id="${id}">
        <i class="fa-solid fa-grip-vertical ac-entry-handle" inert data-tooltip="${e(labels.drag)}"></i>
        <button type="button" class="ac-row-action" data-action="playPlaylistEntry" data-sound-id="${id}" aria-label="${e(labels.play)}" data-tooltip="${e(labels.play)}">
          <i class="fa-solid ${entry.playing ? "fa-volume-high" : "fa-play"}" inert></i>
        </button>
        <span class="ac-entry-name" title="${name}" data-action="playPlaylistEntry" data-sound-id="${id}">${name}</span>
        <span class="ac-entry-duration" data-entry-duration data-path="${e(entry.path)}">${e(entry.duration)}</span>
        <div class="ac-entry-volume">
          <i class="fa-solid fa-volume-low" inert></i>
          <input type="range" min="0" max="1" step="0.01" value="${volumeInput}" data-entry-volume data-sound-id="${id}" aria-label="${e(labels.volume)}: ${name}" aria-valuetext="${e(volumeLabel)}">
        </div>
        ${addButton}
        <button type="button" class="ac-row-action" data-action="removeContainerEntry" data-section="${SECTIONS.PLAYLISTS}" data-sound-id="${id}" aria-label="${e(labels.remove)}" data-tooltip="${e(labels.remove)}">
          <i class="fa-solid fa-xmark" inert></i>
        </button>
      </li>`);
    }
    return html.join("");
  }

  /**
   * The tiles of the Soundboard section's pad grid, as one HTML string.
   *
   * The face is an image with the name along its bottom edge: a pad is aimed at by its picture,
   * but a board built from the library starts with every pad on the same default icon, and then
   * the name is the only thing that tells them apart. The whole name stays on the tooltip for when
   * the face has to truncate it.
   *
   * The grip, not the tile, starts a drag: a pad's whole face is a fire button, and a draggable
   * button is one a click-and-twitch turns into a drag instead of a sound. Configure and remove
   * are not on the tile at all — right-click opens the config, and removing lives inside it
   * (dialogs.js promptPadConfig) — so the face keeps only the two controls used mid-scene.
   *
   * The list view (PAD_VIEWS.LIST) is the same element with its parts laid out in a row, so
   * firing, the playing ring, reordering and right-click all work unchanged. It adds a visible
   * Configure button, because a row has the room for one and right-click is not discoverable, and
   * drops the delayed tooltip, which only existed to show a name the row now prints in full.
   * @param {number} start
   * @param {number} end
   * @returns {string}
   */
  #renderPadTiles(start, end) {
    const e = foundry.utils.escapeHTML;
    const labels = {
      drag: game.i18n.localize("AUDIO_CONSOLE.Soundboard.Actions.Drag"),
      fire: game.i18n.localize("AUDIO_CONSOLE.Soundboard.Actions.Fire"),
      stop: game.i18n.localize("AUDIO_CONSOLE.Soundboard.Actions.Stop"),
      whisper: game.i18n.localize("AUDIO_CONSOLE.Soundboard.Actions.Whisper"),
      configure: game.i18n.localize("AUDIO_CONSOLE.Soundboard.Actions.Configure"),
      addToLibrary: game.i18n.localize("AUDIO_CONSOLE.Playlists.Actions.AddToLibrary")
    };
    const list = this.#padListView;
    const html = [];
    for (let index = start; index < end; index++) {
      const pad = this.#pads[index];
      if (!pad) continue;
      const id = e(pad.id);
      const name = e(pad.name);
      const colour = pad.color ? ` style="--ac-pad-color: ${e(pad.color)};"` : "";
      const badge = pad.randomLabel ? `<span class="ac-badge ac-pad-badge">${e(pad.randomLabel)}</span>` : "";
      const addButton = pad.hasLibraryEntry ? "" : `<button type="button" class="ac-pad-add-library" data-action="addEntryToLibrary" data-section="${SECTIONS.SOUNDBOARDS}" data-sound-id="${id}" aria-label="${e(labels.addToLibrary)}" data-tooltip="${e(labels.addToLibrary)}"><i class="fa-solid fa-plus" inert></i></button>`;
      html.push(`<div class="ac-pad${pad.playing ? " playing" : ""}${pad.color ? " coloured" : ""}" role="listitem"${colour} data-sound-id="${id}">
        <button type="button" class="ac-pad-grip" draggable="true" data-pad-grip data-sound-id="${id}" aria-label="${e(labels.drag)}" data-tooltip="${e(labels.drag)}">
          <i class="fa-solid fa-up-down-left-right" inert></i>
        </button>
        <button type="button" class="ac-pad-fire" data-action="firePad" data-sound-id="${id}" aria-label="${e(pad.playing ? labels.stop : labels.fire)}: ${name}"${list ? "" : ` data-pad-tooltip="${e(game.i18n.format("AUDIO_CONSOLE.Soundboard.Actions.PadHint", { name: pad.name }))}"`}>
          <img class="ac-pad-icon" src="${e(pad.icon)}" alt="" inert>${list ? "" : badge}
          <span class="ac-pad-name" inert${list ? ` title="${name}"` : ""}>${name}</span>${list ? badge : ""}
        </button>
        ${addButton}
        <button type="button" class="ac-pad-whisper" data-action="whisperPad" data-sound-id="${id}" aria-label="${e(labels.whisper)}" data-tooltip="${e(labels.whisper)}"><i class="fa-solid fa-paper-plane" inert></i></button>${list ? `
        <button type="button" class="ac-pad-configure" data-action="configurePad" data-sound-id="${id}" aria-label="${e(labels.configure)}: ${name}" data-tooltip="${e(labels.configure)}"><i class="fa-solid fa-pen" inert></i></button>` : ""}
      </div>`);
    }
    return html.join("");
  }

  /**
   * Attach (or re-attach) the two virtual lists to the elements of a freshly rendered part, and
   * paint them. An existing list is pointed at the new elements rather than rebuilt, which is what
   * carries the scroll offset across a redraw.
   * @param {{resetScroll?: boolean, measurePadGrid?: boolean}} [options] `measurePadGrid` is false
   *   on a first render, where the window has not been positioned yet and the grid's width is not
   *   final; the resize observer's first callback fills it in.
   */
  #bindContainerLists({ resetScroll = false, measurePadGrid = true } = {}) {
    const entryScroll = this.element.querySelector("[data-entry-scroll]");
    const entryEmpty = this.element.querySelector("[data-entry-empty]");
    if (entryScroll) {
      // Scoped to the scroller: Now Playing carries data-entry-list too.
      const elements = {
        scrollEl: entryScroll,
        spacerEl: entryScroll.querySelector("[data-entry-spacer]"),
        windowEl: entryScroll.querySelector("[data-entry-list]")
      };
      if (this.#entryList) this.#entryList.rebind(elements);
      else {
        this.#entryList = new VirtualList({
          ...elements,
          // The stylesheet owns this number (base.css --ac-entry-height). Read off the window
          // root, never off the list element: a re-render replaces the list, and a detached node
          // answers "" for a custom property, which would paint nothing from the first redraw on.
          metrics: () => ({ rowHeight: parseFloat(getComputedStyle(this.element)
            .getPropertyValue("--ac-entry-height")) || 0 }),
          render: (start, end) => this.#renderEntryRows(start, end),
          // Only the rows that just appeared get their duration read.
          onPainted: () => this.#fillDurations()
        });
      }
      this.#entryList.setCount(this.#playlistEntries.length, { resetScroll });
    } else if (this.#entryList) {
      this.#entryList.destroy();
      this.#entryList = null;
    }
    entryEmpty?.classList.toggle("visible", !this.#playlistEntries.length);

    const padScroll = this.element.querySelector("[data-pad-scroll]");
    const padGrid = this.element.querySelector("[data-pad-grid]");
    const padEmpty = this.element.querySelector("[data-pad-empty]");
    if (padScroll && padGrid) {
      const elements = {
        scrollEl: padScroll,
        spacerEl: padScroll.querySelector("[data-pad-spacer]"),
        windowEl: padGrid
      };
      if (this.#padList) this.#padList.rebind(elements);
      else {
        this.#padList = new VirtualList({
          ...elements,
          metrics: () => this.#padMetrics,
          render: (start, end) => this.#renderPadTiles(start, end)
        });
      }
      // Measured here and not left to the observer: its first callback lands at the end of a
      // frame, and a grid that paints nothing until then is a blank pane on every open.
      if (measurePadGrid) this.#fitPadGrid(padGrid);
      this.#padList.setCount(this.#pads.length, { resetScroll });
    } else if (this.#padList) {
      this.#padList.destroy();
      this.#padList = null;
    }
    padEmpty?.classList.toggle("visible", !this.#pads.length);
    this.#watchPadGrid(padGrid);
  }

  /**
   * Fill in the duration cell of every entry row that does not have one yet, patching each row
   * directly as its own read comes back. Cheap to call on every render: a path read once this
   * session answers from memory.
   */
  #fillDurations() {
    for (const cell of this.element.querySelectorAll("[data-entry-duration]")) {
      const path = cell.dataset.path;
      if (!path) continue;
      const known = knownDuration(path);
      if (known !== undefined) {
        cell.textContent = formatDuration(known);
        continue;
      }
      probeDuration(path).then(seconds => {
        // The row may be gone by now; writing to a detached node is harmless but pointless.
        if (cell.isConnected) cell.textContent = formatDuration(seconds);
      });
    }
  }

  /* -------------------------------------------- */
  /*  The container sections, shared              */
  /* -------------------------------------------- */

  /** @this {AudioConsoleNormal} */
  static async #onCreateContainer(event, target) {
    const { section, spec } = this.#sectionOf(target);
    const name = await promptContainerName({
      title: game.i18n.localize(`AUDIO_CONSOLE.${spec.i18n}.Dialogs.CreateTitle`),
      submitLabel: game.i18n.localize(`AUDIO_CONSOLE.${spec.i18n}.Dialogs.CreateSubmit`)
    });
    if (name === null) return;
    const created = await this.#createContainerIn(section, name);
    if (!created) return;
    this.#selectContainer(section, created.id);
    await this.render({ parts: [spec.part] });
  }

  /**
   * A new container in a section, named by the GM or — left blank — by the next free default.
   * @param {string} section A SECTIONS key.
   * @param {string} [name]
   * @returns {Promise<Playlist|null>}
   */
  async #createContainerIn(section, name) {
    const spec = CONTAINER_SECTIONS[section];
    name ||= nextDefaultName(game.i18n.localize(`AUDIO_CONSOLE.${spec.i18n}.Dialogs.DefaultName`),
      getContainers(spec.kind).map(c => c.name));
    const folder = getSectionFolder(section);
    const [created] = await createContainers([{ name, kind: spec.kind, folder: folder?.id ?? null }]);
    return created ?? null;
  }

  /** @this {AudioConsoleNormal} */
  static async #onSelectContainer(event, target) {
    const { section, spec } = this.#sectionOf(target);
    this.#selectContainer(section, target.dataset.containerId);
    await this.render({ parts: [spec.part] });
  }

  /**
   * The three-way choice: release from the module, delete permanently, or cancel. Coherent only
   * for a container — an entry or a library row never gets this dialog.
   * @this {AudioConsoleNormal}
   */
  static async #onDeleteContainer(event, target) {
    const { section, spec, container } = this.#sectionOf(target);
    if (!container) return;
    const choice = await confirmContainerDelete(container);
    if (!choice) return;
    if (choice === "release") await releaseContainers([container]);
    else await deleteContainers([container]);
    AudioConsoleNormal.#closePopout(container.id);
    this.#selected[section] = null;
    await this.render({ parts: [spec.part] });
  }

  /**
   * Play the whole container. Never offered for a soundboard: there is no SOUNDBOARD playlist
   * mode, and playAll() on one is what would turn it back into an ordinary playlist.
   * @this {AudioConsoleNormal}
   */
  static async #onPlayContainer(event, target) {
    const { spec, container } = this.#sectionOf(target);
    if (!container || (spec.kind === CONTAINER_KINDS.SOUNDBOARD)) return;
    await this.setAudioMode(AUDIO_MODES.BROADCAST);
    await playback.playContainer(container);
  }

  /** @this {AudioConsoleNormal} */
  static async #onStopContainer(event, target) {
    const { container } = this.#sectionOf(target);
    if (container) await playback.stopContainer(container);
  }

  /**
   * The Library tab's Add, doing the same thing plus one: the file is registered and dropped into
   * this section's open container.
   * @this {AudioConsoleNormal}
   */
  static async #onAddFileToContainer(event, target) {
    const { spec, container } = this.#sectionOf(target);
    if (!container) return;
    const entry = await this.#library.pickAndRegister();
    if (!entry) return;
    // A file already registered can be picked again, and the container may well hold it.
    if (getEntries(container).some(sound => normalizePath(sound.path) === entry.path)) {
      ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.Containers.Notify.AlreadyThere",
        { name: entry.name, container: container.name }));
      return;
    }
    await createEntries(container, [spec.toSpec(entry)]);
    ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.Playlists.Notify.AddedTo",
      { name: entry.name, container: container.name }));
  }

  /** @this {AudioConsoleNormal} */
  static async #onAddFromLibrary(event, target) {
    const { container } = this.#sectionOf(target);
    if (!container) return;
    const inContainer = new Set(getEntries(container).map(s => normalizePath(s.path)));
    const candidates = library.getAllEntries().filter(entry => !inContainer.has(entry.path));
    if (!candidates.length) {
      ui.notifications.info(game.i18n.localize("AUDIO_CONSOLE.Playlists.Notify.NothingToAdd"));
      return;
    }
    await AudioConsoleLibraryPicker.open({ container, add: (into, paths) => this.#addLibraryPaths(into, paths) });
  }

  /**
   * Library rows into a container, shaped by the section that container lives in. Silent either
   * way — the entries appearing in the console are the acknowledgement. What it already holds is
   * skipped: the picker's own list never offers those, and a drag of a
   * folder that is half in there already means "the rest of it".
   * @param {Playlist} container
   * @param {string[]} paths Library paths.
   */
  async #addLibraryPaths(container, paths) {
    const home = homeOf(container);
    if (!home) return;
    const inContainer = new Set(getEntries(container).map(s => normalizePath(s.path)));
    const specs = paths.filter(path => !inContainer.has(path))
      .map(path => library.getEntry(path)).filter(Boolean).map(home.toSpec);
    if (specs.length) await createEntries(container, specs);
  }

  /**
   * An entry with no library row offers this instead of tags. Silent on success: the dialog
   * closing is the acknowledgement, and a toast per track stacked up when registering several.
   * @this {AudioConsoleNormal}
   */
  static async #onAddEntryToLibrary(event, target) {
    const { container } = this.#sectionOf(target);
    const sound = container?.sounds.get(target.dataset.soundId);
    if (!sound) return;
    const details = await promptNewEntry({
      path: sound.path,
      name: sound.name || humanizeName(basenameOf(sound.path)),
      channel: this.#library.defaultChannel
    });
    if (!details) return;
    const added = library.addEntries([{ path: sound.path, ...details }]);
    if (!added.length) return;
    await library.flushSave();
  }

  /**
   * An entry IS the membership — no confirmation, and the label says exactly what happens.
   * @this {AudioConsoleNormal}
   */
  static async #onRemoveContainerEntry(event, target) {
    const { container } = this.#sectionOf(target);
    if (!container || !target.dataset.soundId) return;
    await deleteEntries(container, [target.dataset.soundId]);
  }

  /**
   * A container-level field, written on "change" (blur/Enter) rather than debounced like a volume
   * drag — there is no audible feedback to keep in step with. Shared by both fade fields; the
   * section comes off the input.
   */
  #onFadeChange = async event => {
    const container = this.#selectedIn(event.target.dataset.section);
    if (!container) return;
    const raw = Number(event.target.value);
    const fade = (Number.isFinite(raw) && (raw > 0)) ? Math.round(raw) : null;
    await updateContainers([{ _id: container.id, fade }]);
  };

  /* -------------------------------------------- */
  /*  Renaming a container, in place               */
  /* -------------------------------------------- */

  /**
   * Turn one card into an editable field. Only ever one at a time across the whole window: a
   * second pencil moves the edit rather than opening another.
   * @this {AudioConsoleNormal}
   */
  static async #onRenameContainer(event, target) {
    const { container } = this.#sectionOf(target);
    if (!container) return;
    this.#editingContainerId = container.id;
    this.#editDraft = container.name;
    this.#renderContainerSection(container);
  }

  /** @this {AudioConsoleNormal} */
  static async #onCommitRenameContainer(event, target) {
    await this.#commitRename(this.#sectionOf(target).container);
  }

  /** @this {AudioConsoleNormal} */
  static async #onCancelRenameContainer() {
    this.#cancelRename();
  }

  /**
   * Redraw the one section a container lives in: the rename flow is local state, so it renders
   * itself, and opening a rename field in the Ambience must not rebuild a 300-track playlist.
   * @param {Playlist|null} container Null falls back to a full render.
   */
  #renderContainerSection(container) {
    const part = homeOf(container)?.part;
    if (!part) return void this.render();
    this.render({ parts: [part] });
  }

  /**
   * Write the typed name, or treat it as a cancel: typing nothing, or the original name back, is
   * not an error worth a warning.
   * @param {Playlist|null} container Re-read at commit time rather than captured when the field
   *   opened, so a rename that raced a delete does not write to a document that is gone.
   */
  async #commitRename(container) {
    const name = this.#editDraft.trim();
    this.#editingContainerId = null;
    this.#editDraft = "";
    if (!container || !name || (name === container.name)) {
      this.#renderContainerSection(container);
      return;
    }
    // updateContainers() fires the document hook this window redraws on.
    await updateContainers([{ _id: container.id, name }]);
  }

  #cancelRename() {
    // Read before clearing: once the id is null nothing says which section the field was in.
    const container = this.#editingContainer();
    this.#editingContainerId = null;
    this.#editDraft = "";
    this.#renderContainerSection(container);
  }

  #onRenameInput = event => {
    this.#editDraft = event.target.value;
  };

  #onRenameKeydown = event => {
    if (event.key === "Enter") {
      event.preventDefault();
      this.#commitRename(this.#editingContainer());
      return;
    }
    if (event.key !== "Escape") return;
    // Stopped here so the key abandons the field rather than reaching ApplicationV2's own
    // handler, which would close the whole console.
    event.preventDefault();
    event.stopPropagation();
    this.#cancelRename();
  };

  /** @returns {Playlist|null} The container being renamed, whichever section it lives in. */
  #editingContainer() {
    if (!this.#editingContainerId) return null;
    const container = game.playlists.get(this.#editingContainerId);
    return isContainer(container) ? container : null;
  }

  /* -------------------------------------------- */
  /*  Playlists                                    */
  /* -------------------------------------------- */

  /**
   * Sequential <-> shuffle only. Not native cycleMode(): that walks all four PLAYLIST_MODES and
   * stops every sound first. Read off the button rather than off `container.mode`: a second click
   * before the first write echoes back must invert what the GM last asked for.
   * @this {AudioConsoleNormal}
   */
  static async #onTogglePlaylistMode(event, target) {
    const container = this.#selectedIn(SECTIONS.PLAYLISTS);
    if (!container) return;
    const modes = foundry.CONST.PLAYLIST_MODES;
    const shuffle = target.getAttribute("aria-pressed") !== "true";
    paintModeButton(target, shuffle);
    const [updated] = await updateContainers([{ _id: container.id, mode: shuffle ? modes.SHUFFLE : modes.SEQUENTIAL }]);
    if (!updated) paintModeButton(target, !shuffle);
  }

  /** @this {AudioConsoleNormal} */
  static async #onPlayPlaylistEntry(event, target) {
    const container = this.#selectedIn(SECTIONS.PLAYLISTS);
    const sound = container?.sounds.get(target.dataset.soundId);
    if (!container || !sound) return;
    await this.setAudioMode(AUDIO_MODES.BROADCAST);
    await playback.playEntry(container, sound);
  }

  /* -------------------------------------------- */
  /*  Picker drops on a container list             */
  /* -------------------------------------------- */

  /**
   * Only the "Add from Library" picker's drag is accepted here (library-picker.js
   * #onRowDragStart). Its payload is unreadable until the drop, so it is recognised by its MIME
   * type alone.
   */
  #onContainerListDragOver = event => {
    if (!event.dataTransfer.types.includes(PICKER_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    this.#markContainerDrop(event.currentTarget, event.target.closest("[data-container-id]"));
  };

  #onContainerListDragLeave = event => {
    if (!event.currentTarget.contains(event.relatedTarget)) this.#markContainerDrop(event.currentTarget, null, false);
  };

  /**
   * Show where a drop would land: on a card, into that container; anywhere else in the list, into
   * a new one.
   * @param {HTMLElement} list
   * @param {HTMLElement|null} card
   * @param {boolean} [active] False clears both marks.
   */
  #markContainerDrop(list, card, active = true) {
    for (const el of list.querySelectorAll(".drop-target")) {
      if (el !== card) el.classList.remove("drop-target");
    }
    card?.classList.add("drop-target");
    list.classList.toggle("drop-new", active && !card);
  }

  /**
   * A drop on a card adds to that container; a drop on the list around the cards creates one,
   * named the way "New" names a container left blank. Either way it becomes the selected
   * container, which also makes it the picker's target.
   */
  #onContainerListDrop = async event => {
    const list = event.currentTarget;
    this.#markContainerDrop(list, null, false);
    if (!event.dataTransfer.types.includes(PICKER_DRAG_TYPE)) return;
    event.preventDefault();
    let paths;
    try {
      paths = JSON.parse(event.dataTransfer.getData(PICKER_DRAG_TYPE));
    } catch {
      return;
    }
    if (!Array.isArray(paths)) return;
    paths = paths.filter(path => typeof path === "string");
    const section = list.dataset.section;
    const spec = CONTAINER_SECTIONS[section];
    if (!spec || !paths.length) return;
    const id = event.target.closest("[data-container-id]")?.dataset.containerId;
    const container = id ? game.playlists.get(id) : await this.#createContainerIn(section);
    if (!isContainer(container)) return;
    await this.#addLibraryPaths(container, paths);
    this.#selectContainer(section, container.id);
    await this.render({ parts: [spec.part] });
  };

  /* -------------------------------------------- */
  /*  Entry drag-to-reorder                        */
  /* -------------------------------------------- */

  #onEntryDragStart = event => {
    const row = event.target.closest("[data-sound-id]");
    if (!row) return;
    this.#dragSoundId = row.dataset.soundId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", row.dataset.soundId);
  };

  #onEntryDragOver = event => {
    const row = event.target.closest("[data-sound-id]");
    if (!row || !this.#dragSoundId || (row.dataset.soundId === this.#dragSoundId)) return;
    event.preventDefault();
    const before = (event.clientY - row.getBoundingClientRect().top) < (row.offsetHeight / 2);
    row.classList.toggle("drag-over-before", before);
    row.classList.toggle("drag-over-after", !before);
  };

  #onEntryDragLeave = event => {
    event.target.closest("[data-sound-id]")?.classList.remove("drag-over-before", "drag-over-after");
  };

  #onEntryDragEnd = () => {
    this.#dragSoundId = null;
    this.#clearDragIndicators();
  };

  /**
   * The container an entry list belongs to, read off the list element: Playlists and Now Playing
   * share these handlers and only one of them has a selection at all.
   * @param {HTMLElement} target Anything inside the list.
   * @returns {Playlist|null}
   */
  #containerForList(target) {
    const id = target.closest("[data-entry-list]")?.dataset.containerId;
    const container = id ? game.playlists.get(id) : null;
    return isContainer(container) ? container : null;
  }

  #clearDragIndicators() {
    for (const el of this.element.querySelectorAll(".drag-over-before, .drag-over-after")) {
      el.classList.remove("drag-over-before", "drag-over-after");
    }
  }

  /**
   * Reorder via foundry.utils.performIntegerSort, which is what core's own directories use. It
   * returns {target, update} pairs against real documents, batched into one updateEntries() call.
   */
  #onEntryDrop = async event => {
    const row = event.target.closest("[data-sound-id]");
    const draggedId = this.#dragSoundId;
    this.#clearDragIndicators();
    this.#dragSoundId = null;
    if (!row || !draggedId || (row.dataset.soundId === draggedId)) return;
    event.preventDefault();
    const container = this.#containerForList(row);
    if (!container) return;
    const entries = getEntries(container);
    const source = entries.find(s => s.id === draggedId);
    const target = entries.find(s => s.id === row.dataset.soundId);
    if (!source || !target) return;
    const sortBefore = (event.clientY - row.getBoundingClientRect().top) < (row.offsetHeight / 2);
    const siblings = entries.filter(s => s !== source);
    const updates = foundry.utils.performIntegerSort(source, { target, siblings, sortBefore })
      .map(({ target: t, update }) => ({ _id: t.id, ...update }));
    await updateEntries(container, updates);
  };

  /* -------------------------------------------- */
  /*  Now Playing                                  */
  /* -------------------------------------------- */

  /** @this {AudioConsoleNormal} */
  static async #onPlayQueue() {
    const queue = getQueue();
    if (!queue) return;
    await this.setAudioMode(AUDIO_MODES.BROADCAST);
    await playback.playContainer(queue);
  }

  /** @this {AudioConsoleNormal} */
  static async #onStopQueue() {
    const queue = getQueue();
    if (queue) await playback.stopContainer(queue);
  }

  /**
   * Empty the running order. Confirmed, unlike removing a single track: the queue is built one
   * track at a time and there is nothing to rebuild it from.
   * @this {AudioConsoleNormal}
   */
  static async #onClearQueue() {
    const queue = getQueue();
    const count = queue ? getEntries(queue).length : 0;
    if (!count) return;
    if (!await confirmClearQueue(count)) return;
    await playback.clearQueue();
  }

  /**
   * Play/pause on the same button: this is the list a GM runs a session from, so the track under
   * the pointer is the one they most want to stop without reaching for the transport.
   * @this {AudioConsoleNormal}
   */
  static async #onPlayQueueEntry(event, target) {
    const queue = getQueue();
    const sound = queue?.sounds.get(target.dataset.soundId);
    if (!queue || !sound) return;
    if (sound.playing) {
      await playback.pauseEntry(sound);
      return;
    }
    await this.setAudioMode(AUDIO_MODES.BROADCAST);
    await playback.playEntry(queue, sound);
  }

  /** @this {AudioConsoleNormal} */
  static async #onRemoveQueueEntry(event, target) {
    const queue = getQueue();
    if (!queue || !target.dataset.soundId) return;
    await deleteEntries(queue, [target.dataset.soundId]);
  }

  /* -------------------------------------------- */
  /*  Soundboard                                   */
  /* -------------------------------------------- */

  /**
   * Lower the music while a pad of this board plays (audio/ducking.js). A flag on the board, so
   * every client — the ones actually doing the ducking — reads the same answer.
   * @this {AudioConsoleNormal}
   */
  static async #onToggleDuck(event, target) {
    const { container } = this.#sectionOf(target);
    if (!isContainer(container)) return;
    const flags = readContainerFlags(container);
    const duck = target.getAttribute("aria-pressed") !== "true";
    paintToggle(target, duck);
    const [updated] = await updateContainers([{
      _id: container.id,
      flags: { [MODULE_ID]: buildContainerFlags({ ...flags, duck }) }
    }]);
    if (!updated) paintToggle(target, !duck);
  }

  /**
   * The selected board's background colour. Written to the container, so every console and the
   * board's popout redraw with it through the ordinary structural-change path — nothing here
   * reaches into another window.
   * @this {AudioConsoleNormal}
   */
  static async #onBoardColor(event, target) {
    const { container } = this.#sectionOf(target);
    if (!isContainer(container)) return;
    const flags = readContainerFlags(container);
    const result = await promptBoardColor({ name: container.name, color: flags.color });
    if (!result) return;
    await updateContainers([{
      _id: container.id,
      flags: { [MODULE_ID]: buildContainerFlags({ ...flags, color: result.color }) }
    }]);
  }

  /**
   * Switch the selected board between grid and list. A flag on the board, like its colour, so the
   * console and the board's popout both redraw with it through the ordinary document hook.
   * @this {AudioConsoleNormal}
   */
  static async #onTogglePadView(event, target) {
    const { container } = this.#sectionOf(target);
    if (!isContainer(container)) return;
    const flags = readContainerFlags(container);
    const view = flags.view === PAD_VIEWS.LIST ? PAD_VIEWS.GRID : PAD_VIEWS.LIST;
    await updateContainers([{
      _id: container.id,
      flags: { [MODULE_ID]: buildContainerFlags({ ...flags, view }) }
    }]);
  }

  /** The list view's Configure button — the same dialog right-click opens. @this {AudioConsoleNormal} */
  static async #onConfigurePad(event, target) {
    await this.#configurePad(target.dataset.soundId);
  }

  /**
   * Click toggles: a pad that is playing stops, any other fires. The random scheduler calls
   * playback.playEntry() directly and never sees this.
   * @this {AudioConsoleNormal}
   */
  static async #onFirePad(event, target) {
    const container = this.#selectedIn(SECTIONS.SOUNDBOARDS);
    const sound = container?.sounds.get(target.dataset.soundId);
    if (!container || !sound) return;
    if (sound.playing) {
      await playback.stopEntry(sound);
      return;
    }
    await this.setAudioMode(AUDIO_MODES.BROADCAST);
    await playback.playEntry(container, sound);
  }

  /**
   * Send this pad to one connected player, and hear it here at the same time. Deliberately does
   * NOT move the audio mode: a whisper is neither a preview nor a broadcast, and the interlock
   * exists to stop a *silent* reveal — picking a person by name is the opposite of silent.
   * @this {AudioConsoleNormal}
   */
  static async #onWhisperPad(event, target) {
    const container = this.#selectedIn(SECTIONS.SOUNDBOARDS);
    const sound = container?.sounds.get(target.dataset.soundId);
    if (!sound) return;
    const users = whisper.whisperTargets();
    if (!users.length) {
      ui.notifications.warn(game.i18n.localize("AUDIO_CONSOLE.Soundboard.Notify.NoWhisperTargets"));
      return;
    }
    const userId = await promptWhisperTarget({
      padName: sound.name,
      users: users.map(u => ({ id: u.id, name: u.name }))
    });
    if (!userId) return;
    const played = await whisper.whisperEntry(sound, userId);
    // AudioHelper.play() resolves a Sound even when the source 404s. The local load and the remote
    // one fetch the same path, so a failure here is a failure there.
    if (played?.failed) {
      ui.notifications.warn(game.i18n.format("AUDIO_CONSOLE.Transport.Notify.PlaybackFailed", { name: sound.name }));
      return;
    }
    ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.Soundboard.Notify.Whispered",
      { name: sound.name, user: game.users.get(userId)?.name ?? "" }));
  }

  /**
   * Shared by the cog button and right-click on the pad itself.
   * @param {string} soundId
   */
  async #configurePad(soundId) {
    const container = this.#selectedIn(SECTIONS.SOUNDBOARDS);
    const sound = container?.sounds.get(soundId);
    if (!container || !sound) return;
    const flags = readEntryFlags(sound);
    const result = await promptPadConfig({
      name: sound.name,
      path: sound.path,
      label: flags.label,
      volume: sound.volume,
      loop: sound.repeat,
      color: flags.color,
      icon: flags.icon,
      random: flags.random
    });
    if (!result) return;
    if (result === "remove") {
      await deleteEntries(container, [sound.id]);
      return;
    }
    // Spread the existing flags first: a flag write replaces the whole scope.
    await updateEntries(container, [{
      _id: sound.id,
      volume: result.volume,
      repeat: result.loop,
      flags: { [MODULE_ID]: buildEntryFlags({ ...flags, label: result.label, color: result.color, icon: result.icon, random: result.random }) }
    }]);
  }

  /**
   * The pad face's tooltip, on a delay of its own (PAD_TOOLTIP_DELAY_MS). The face carries
   * `data-pad-tooltip` rather than `data-tooltip` so core's manager never starts its own, shorter
   * timer on it; once shown, it is core's tooltip like any other and core's pointerleave takes it
   * down.
   */
  #onPadPointerEnter = event => {
    const face = event.target;
    if (!face.dataset?.padTooltip) return;
    this.#cancelPadTooltip();
    this.#padTooltipTimer = window.setTimeout(() => {
      this.#padTooltipTimer = null;
      if (face.isConnected && face.matches(":hover")) game.tooltip.activate(face, { text: face.dataset.padTooltip });
    }, PAD_TOOLTIP_DELAY_MS);
  };

  /**
   * Only the face's own leave counts: with capture on, leaving the random-interval badge inside it
   * arrives here too, and the pointer is still on the face.
   */
  #onPadPointerLeave = event => {
    if (event.target.dataset?.padTooltip) this.#cancelPadTooltip();
  };

  /** Also on pointerdown: a GM who clicked the pad is playing it, not waiting to read about it. */
  #cancelPadTooltip = () => {
    if (this.#padTooltipTimer === null) return;
    window.clearTimeout(this.#padTooltipTimer);
    this.#padTooltipTimer = null;
  };

  #onPadContextMenu = event => {
    const pad = event.target.closest("[data-sound-id]");
    if (!pad) return;
    event.preventDefault();
    this.#configurePad(pad.dataset.soundId);
  };

  /**
   * Reordering a board: the same performIntegerSort path the entry lists use, with the drop side
   * decided on the pointer's X against the tile's midpoint, because a grid flows left to right.
   *
   * The same drag also reaches two targets outside the grid. The hotbar leaves a standalone macro
   * (data/sound-macros.js), and the canvas is core's own PlaylistSound drop, which opens an
   * AmbientSound preview at the cursor — hence `type: "PlaylistSound"`, which core's switch matches,
   * while the module id key is what the hotbar hook reads to tell a pad apart from a sidebar drag.
   */
  #onPadDragStart = event => {
    const grip = event.target.closest("[data-pad-grip]");
    const pad = grip?.closest(".ac-pad");
    if (!grip || !pad) return;
    this.#dragPadId = grip.dataset.soundId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", JSON.stringify({
      type: "PlaylistSound",
      uuid: this.#selectedIn(SECTIONS.SOUNDBOARDS)?.sounds.get(this.#dragPadId)?.uuid,
      [MODULE_ID]: SOUND_DRAG_MARKER
    }));
    // The ghost is the tile, not the 22px grip that was actually picked up.
    event.dataTransfer.setDragImage(pad, pad.offsetWidth / 2, pad.offsetHeight / 2);
  };

  #onPadDragOver = event => {
    const pad = event.target.closest(".ac-pad");
    if (!pad || !this.#dragPadId || (pad.dataset.soundId === this.#dragPadId)) return;
    event.preventDefault();
    const before = this.#dropsBefore(event, pad);
    pad.classList.toggle("drag-over-before", before);
    pad.classList.toggle("drag-over-after", !before);
  };

  /**
   * Which side of a pad a drop lands on: the pointer's X against the tile's midpoint in the grid,
   * which flows left to right, and its Y against the row's midpoint in the list, which flows down.
   * @param {DragEvent} event
   * @param {HTMLElement} pad
   * @returns {boolean}
   */
  #dropsBefore(event, pad) {
    const rect = pad.getBoundingClientRect();
    return this.#padListView
      ? (event.clientY - rect.top) < (rect.height / 2)
      : (event.clientX - rect.left) < (rect.width / 2);
  }

  #onPadDragLeave = event => {
    event.target.closest(".ac-pad")?.classList.remove("drag-over-before", "drag-over-after");
  };

  #onPadDragEnd = () => {
    this.#dragPadId = null;
    this.#clearDragIndicators();
  };

  #onPadDrop = async event => {
    const pad = event.target.closest(".ac-pad");
    const draggedId = this.#dragPadId;
    this.#clearDragIndicators();
    this.#dragPadId = null;
    if (!pad || !draggedId || (pad.dataset.soundId === draggedId)) return;
    event.preventDefault();
    const container = this.#selectedIn(SECTIONS.SOUNDBOARDS);
    if (!container) return;
    const pads = getEntries(container);
    const source = pads.find(s => s.id === draggedId);
    const target = pads.find(s => s.id === pad.dataset.soundId);
    if (!source || !target) return;
    const sortBefore = this.#dropsBefore(event, pad);
    const siblings = pads.filter(s => s !== source);
    const updates = foundry.utils.performIntegerSort(source, { target, siblings, sortBefore })
      .map(({ target: t, update }) => ({ _id: t.id, ...update }));
    await updateEntries(container, updates);
  };

  /* -------------------------------------------- */
  /*  Ambience                                     */
  /* -------------------------------------------- */

  /**
   * The document field directly — a one-shot write, nothing to debounce. Read off the button, not
   * off `sound.repeat`: a second click before the first write echoes back must invert what the GM
   * last asked for.
   * @this {AudioConsoleNormal}
   */
  static async #onToggleLayerLoop(event, target) {
    const container = this.#selectedIn(SECTIONS.AMBIENCES);
    const sound = container?.sounds.get(target.dataset.soundId);
    if (!container || !sound) return;
    const repeat = target.getAttribute("aria-pressed") !== "true";
    paintToggle(target, repeat);
    // Loop and random interval are two answers to one question (dialogs.js playbackField), so
    // turning loop on here turns random off in the same write — otherwise the row could reach the
    // combination the dialog no longer offers. Turning loop off leaves random alone.
    const update = { _id: sound.id, repeat };
    const flags = readEntryFlags(sound);
    if (repeat && flags.random.enabled) {
      update.flags = { [MODULE_ID]: buildEntryFlags({ ...flags, random: { ...flags.random, enabled: false } }) };
    }
    const [updated] = await updateEntries(container, [update]);
    // A refused write returns nothing and fires no hook, so the render that would correct the
    // button never comes. Put it back.
    if (!updated) paintToggle(target, !repeat);
  }

  /**
   * A layer's playback — volume, once/loop/random, and the random range — in the same shape as a
   * pad's Sound tab.
   * @this {AudioConsoleNormal}
   */
  static async #onConfigureLayerPlayback(event, target) {
    const container = this.#selectedIn(SECTIONS.AMBIENCES);
    const sound = container?.sounds.get(target.dataset.soundId);
    if (!container || !sound) return;
    const flags = readEntryFlags(sound);
    const result = await promptLayerPlayback({
      name: sound.name,
      path: sound.path,
      volume: sound.volume,
      loop: sound.repeat,
      random: flags.random
    });
    if (!result) return;
    await updateEntries(container, [{
      _id: sound.id,
      volume: result.volume,
      repeat: result.loop,
      flags: { [MODULE_ID]: buildEntryFlags({ ...flags, random: result.random }) }
    }]);
  }

  /**
   * The three-step slider idiom core's own playlist directory uses: the local source and the
   * audio node move immediately so the drag is audible without a round trip, and only the write
   * is debounced (PlaylistSound#debounceVolume). Delegated on each list and shared by the ambience
   * layers, the Playlists entries and Now Playing, so the container is read off the list's own
   * data-container-id.
   */
  #onEntryVolumeInput = event => {
    const input = event.target.closest("[data-entry-volume]");
    if (!input) return;
    const id = input.closest("[data-container-id]")?.dataset.containerId;
    const container = id ? game.playlists.get(id) : null;
    const sound = container?.sounds.get(input.dataset.soundId);
    if (!sound) return;
    const volume = foundry.audio.AudioHelper.inputToVolume(Number(input.value));
    input.setAttribute("aria-valuetext", foundry.audio.AudioHelper.volumeToPercentage(Number(input.value), { label: true }));
    sound.updateSource({ volume });
    sound.sound?.fade(volume, { duration: foundry.documents.PlaylistSound.implementation.VOLUME_DEBOUNCE_MS });
    playback.setEntryVolume(sound, volume);
  };
}
