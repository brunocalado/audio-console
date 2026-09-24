/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { DISPLAY_MODES, MODULE_ID, SETTINGS } from "../constants.js";
import { AudioConsoleApplication } from "./console-base.js";

const TEMPLATES = `modules/${MODULE_ID}/templates/compact`;

// How long the bar sits untouched before it dims. Core's own faded UI has no timer at all — it is
// dim whenever the pointer is elsewhere — the grace period is this bar's own behaviour.
const IDLE_FADE_MS = 5000;

/**
 * Compact mode: a small frameless bar. It reads out what is playing and offers play/pause, skip
 * and a way back to the full console — nothing else, by design. Nothing here starts audio, so the
 * bar reads no containers, never touches the interlock, and needs no render context of its own:
 * everything it shows is written by the base class's updateTransport().
 */
export class AudioConsoleCompact extends AudioConsoleApplication {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-compact`,
    classes: [`${MODULE_ID}-compact`],
    window: {
      // Frameless: no title bar, no native drag/resize. _onRender wires its own drag handle (a
      // ~360x64 frameless bar) since ApplicationV2 only sets that up for a framed window's header
      // (confirmed in v14.365 client/applications/api/application.mjs).
      frame: false,
      positioned: true,
      resizable: false
    },
    // Keep in step with the width in styles/console-compact.css — see the note there.
    position: { width: 300, height: 64 },
    actions: {
      expandMode: AudioConsoleCompact.#onExpandMode
    }
  };

  /** @override */
  static PARTS = {
    bar: { template: `${TEMPLATES}/bar.hbs` }
  };

  /** @type {object|null} The foundry.applications.ux.Draggable instance bound to the grip handle. */
  #draggable = null;

  /** @type {number|null} The pending dim, or null when the bar is already dim or unrendered. */
  #fadeTimer = null;

  /** Whether the idle listeners are attached. The root element survives a re-render, so binding
   *  is once per instance rather than once per render. */
  #fadeBound = false;

  /**
   * Restore the last screen position, if the GM has moved the bar before. Reading the setting
   * here rather than in DEFAULT_OPTIONS: DEFAULT_OPTIONS is evaluated once at class-definition
   * time, before game.settings exists; this runs per-instance, after `ready`, when it does.
   * @override
   */
  _initializeApplicationOptions(options) {
    const applicationOptions = super._initializeApplicationOptions(options);
    const saved = game.settings.get(MODULE_ID, SETTINGS.COMPACT_POSITION);
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
      applicationOptions.position.left = saved.left;
      applicationOptions.position.top = saved.top;
    }
    return applicationOptions;
  }

  /* -------------------------------------------- */
  /*  Render                                      */
  /* -------------------------------------------- */

  /* -------------------------------------------- */
  /*  Idle fade                                   */
  /* -------------------------------------------- */

  /**
   * Dim the bar once it has been left alone, and bring it back the moment it is touched.
   *
   * The class is the module's own, deliberately. Core's `faded-ui` gives the same look and was
   * used here first, but it is core's internal hook rather than an extension point: core already
   * hangs extra rules off it (`#hotbar.faded-ui` gets a transform transition, `.detached
   * .faded-ui` forces full opacity), and a class that sets the opacity of a whole window is the
   * last one to borrow — anything core changed about it would silently change whether this bar can
   * be seen. `ac-idle` is styled in console-compact.css to core's own values, so the bar still
   * dims like the rest of the UI without depending on core's stylesheet to do it.
   *
   * The countdown is held while the pointer is over the bar and restarted when it leaves, so the
   * rule is the same however the bar was used: five seconds after you stop. Without that hold, a
   * pointer resting still on the bar would let the timer run underneath it — the stylesheet's
   * `:hover` would keep it lit, and it would blink straight to dim the instant the pointer left.
   */
  #scheduleFade() {
    this.#cancelFade();
    this.#fadeTimer = window.setTimeout(() => {
      this.#fadeTimer = null;
      this.element?.classList.add("ac-idle");
    }, IDLE_FADE_MS);
  }

  #cancelFade() {
    if (this.#fadeTimer !== null) window.clearTimeout(this.#fadeTimer);
    this.#fadeTimer = null;
  }

  /** Full opacity now, and the countdown starts again. */
  #wake = () => {
    this.element?.classList.remove("ac-idle");
    this.#scheduleFade();
  };

  /** Lit and held: the pointer is on the bar, so it is in use however long it rests there. */
  #holdAwake = () => {
    this.element?.classList.remove("ac-idle");
    this.#cancelFade();
  };

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    // Always start lit. A render is the one moment the bar is certainly wanted on screen, so this
    // is what guarantees no stale dim survives a reopen or a mode switch.
    this.element.classList.remove("ac-idle");

    // pointermove rather than pointerenter alone: a pointer already resting on the bar when it
    // renders never enters it, and moving across it is the most ordinary way of "using" it
    // without clicking. focusin/keydown cover the keyboard, which pointer events never see.
    if (!this.#fadeBound) {
      for (const type of ["pointermove", "pointerdown", "focusin", "keydown"]) {
        this.element.addEventListener(type, this.#wake, { passive: true });
      }
      this.element.addEventListener("pointerenter", this.#holdAwake, { passive: true });
      this.element.addEventListener("pointerleave", this.#wake, { passive: true });
      this.#fadeBound = true;
    }
    this.#wake();

    // Foundry only wires window dragging to a framed window's own header, and this frameless bar
    // has none, so this makes the dedicated grip a drag handle by hand. Guarded so a later
    // render — the same element by identity, since this is a root part — does not stack listeners.
    const handle = this.element.querySelector("[data-drag-handle]");
    if (handle && (handle !== this.#draggable?.handle)) {
      this.#draggable = new foundry.applications.ux.Draggable(this, this.element, handle, false);
    }
  }

  /** @inheritDoc */
  _onPosition(position) {
    super._onPosition(position);
    this.#savePosition(position);
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    this.#draggable = null;
    this.#cancelFade();
    // The listeners went with the element; a reopened bar binds its own.
    this.#fadeBound = false;
  }

  // Debounced the same way the transport's own volume slider is: a drag fires this continuously,
  // and only the final resting position is worth writing to the client setting.
  #savePosition = foundry.utils.debounce(position => {
    game.settings.set(MODULE_ID, SETTINGS.COMPACT_POSITION, { left: position.left, top: position.top });
  }, 500);

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /** @this {AudioConsoleCompact} */
  static async #onExpandMode() {
    await this.switchDisplayMode(DISPLAY_MODES.NORMAL);
  }
}
