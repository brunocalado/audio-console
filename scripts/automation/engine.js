/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import {
  ACTIONS,
  AUTOMATION_CHANGED_HOOK,
  AUTOMATION_LOG_SIZE,
  DARKNESS_OPERATORS,
  MODULE_ID,
  TRIGGER_TYPES
} from "../constants.js";
import { containerKindOf, isContainer, isOn } from "../data/repository.js";
import * as playback from "../audio/playback.js";
import { getRule, getRules, isArmed } from "./rules.js";

// The engine: what watches the world, decides which rules match, and calls playback.js. It owns no
// UI and stores nothing in the world — the rules are rules.js's, the audio is playback.js's, and
// what is left here is the decision and the bookkeeping needed to undo it.
//
// Everything it does is a native document write through playback.js. There is no socket here and
// there must never be one: automation reaches the table by exactly the path a button press does.

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

/**
 * Which state rules are currently inside their condition, by rule id. This is what makes a rule
 * edge-triggered: a rule already "on" is not fired again just because the scene was written to,
 * and the exit half of a state rule has something to happen *at*.
 * @type {Map<string, boolean>}
 */
const activeStates = new Map();

/**
 * What each rule started, by rule id — the whole reason automation can let go of its own audio
 * without ever touching the GM's.
 *
 * A rule only stops what this map says it started. That single invariant answers three separate
 * problems at once: a state rule leaving its condition knows exactly what to silence; a track the
 * GM started by hand is never stomped, because no rule owns it; and a rule whose condition is
 * re-asserted does not restart audio that is already playing.
 * @type {Map<string, {containerId: string, soundId: string}>}
 */
const ownership = new Map();

/**
 * The last few fires, newest first. In memory on purpose — see AUTOMATION_LOG_SIZE.
 * @type {{ruleId: string, at: number, how: string, outcome: string}[]}
 */
const log = [];

/**
 * Round-per-combat as this client last saw it, so "the encounter started" can be detected as a
 * transition rather than read off a single update.
 *
 * Kept here rather than derived from Combat#previous because that field is already rewritten by
 * the time an update hook runs, and because the alternative — the `combatStart` hook — only fires
 * on the client that pressed the button, which is not necessarily the active GM running this
 * engine (v14.367, client/documents/combat.mjs:208-210).
 * @type {Map<string, number>}
 */
const combatRounds = new Map();

let registered = false;

/* -------------------------------------------- */
/*  Gating                                      */
/* -------------------------------------------- */

/**
 * Whether *this* client is the one that runs the rules.
 *
 * Every hook the engine listens to fires on every client. Without this, a table with two GMs
 * connected would play each automated cue twice. `activeGM` is core's own answer to exactly this
 * question and is what its ActiveEffect registry uses (v14.367,
 * client/helpers/active-effect-registry.mjs:146).
 * @returns {boolean}
 */
function isDriver() {
  return game.users.activeGM?.isSelf === true;
}

/**
 * @returns {boolean} Whether rules should be evaluated at all right now.
 */
function isRunning() {
  return isDriver() && isArmed();
}

/* -------------------------------------------- */
/*  Matching                                    */
/* -------------------------------------------- */

/**
 * The scene the rules are about: the one the table is on, never the one this GM happens to be
 * looking at.
 *
 * That distinction is the reason darkness is read from the Scene document rather than from the
 * canvas. `canvas.environment` is the *viewed* scene, and its darknessChange event also fires once
 * per animation frame while a transition plays out (v14.367,
 * client/canvas/groups/effects.mjs:523) — hundreds of events for one change. The document is
 * written once, holds the target value immediately, arrives on every client, and is right even
 * when this GM is off looking at another map.
 * @returns {Scene|null}
 */
function activeScene() {
  return game.scenes?.active ?? null;
}

/**
 * Whether a state rule's condition currently holds.
 * @param {AutomationRule} rule
 * @param {Scene|null} scene
 * @returns {boolean}
 */
function stateMatches(rule, scene) {
  if (!scene) return false;
  switch (rule.trigger.type) {
    case TRIGGER_TYPES.WEATHER:
      // "" is the scene's own "no weather" state, which a GM selects deliberately, so it compares
      // like any other value rather than being treated as "unset".
      return (scene.weather ?? "") === rule.trigger.weather;
    case TRIGGER_TYPES.DARKNESS: {
      const level = scene.environment.darknessLevel;
      return rule.trigger.operator === DARKNESS_OPERATORS.AT_LEAST
        ? level >= rule.trigger.threshold
        : level < rule.trigger.threshold;
    }
    case TRIGGER_TYPES.SCENE:
      return !!rule.trigger.sceneId && (scene.id === rule.trigger.sceneId);
    case TRIGGER_TYPES.TIME:
      return hourInWindow(currentHour(), rule.trigger.fromHour, rule.trigger.toHour);
    default:
      return false;
  }
}

/**
 * The hour of the world calendar's day, as the game clock reads it. `game.time.components` is
 * core's own decomposition of worldTime through the configured calendar (v14.368), so a system
 * that ships its own calendar is read the way it means to be.
 * @returns {number}
 */
function currentHour() {
  return game.time.components?.hour ?? 0;
}

/**
 * Whether an hour falls in [from, to), wrapping past midnight when the window ends at or before
 * it starts. from === to is a full day: a window of no hours would be a rule that can never hold.
 * @param {number} hour
 * @param {number} from
 * @param {number} to
 * @returns {boolean}
 */
function hourInWindow(hour, from, to) {
  if (from < to) return (hour >= from) && (hour < to);
  return (hour >= from) || (hour < to);
}

/* -------------------------------------------- */
/*  Firing                                      */
/* -------------------------------------------- */

/**
 * @param {AutomationRule} rule
 * @param {string} how "enter", "event", or "test" — what caused this, for the log.
 * @param {string} outcome A LogOutcome key; "ok" unless something was missing.
 */
function record(rule, how, outcome) {
  log.unshift({ ruleId: rule.id, at: Date.now(), how, outcome });
  if (log.length > AUTOMATION_LOG_SIZE) log.length = AUTOMATION_LOG_SIZE;
  foundry.helpers.Hooks.callAll(AUTOMATION_CHANGED_HOOK);
}

/**
 * Run a rule's action, and remember what it started.
 *
 * The whole dispatch comes off the ACTIONS table rather than a switch per action id: eight actions
 * are three behaviours (start a container, start one sound in it, silence it) crossed with which
 * kind of container they name, and spelling that out eight times is how the two drift apart.
 *
 * "Already playing" is checked before every play: a rule re-entering its condition against audio
 * that never stopped would otherwise restart the track from the top. Taking ownership without
 * firing is the right answer there — the rule is responsible for that audio either way.
 *
 * @param {AutomationRule} rule
 * @param {string} how For the log.
 * @returns {Promise<void>}
 */
async function fire(rule, how) {
  const spec = ACTIONS[rule.action.type];
  if (!spec) return record(rule, how, "unknownAction");

  // Stops everything and names nothing, so it is answered before anything tries to resolve a
  // container. Two rules on the same trigger, this one above the other in the list, are how a GM
  // gets "silence the table, then start the battle music": list order is the sequence, and fires
  // are awaited one at a time.
  if (!spec.kind) {
    ownership.delete(rule.id);
    await playback.stopEverything();
    return record(rule, how, "ok");
  }

  const container = game.playlists.get(rule.action.containerId);
  if (!isContainer(container)) return record(rule, how, "missingContainer");
  // Enforced where it reaches the audio, not only in the dialog that writes rules: a container
  // re-flagged to another kind under a stored rule lands here, and refusing is the only answer
  // that is not "fire the wrong thing".
  if (containerKindOf(container) !== spec.kind) return record(rule, how, "wrongKind");

  if (spec.stop) {
    // A stop owns nothing — there is nothing for the exit half of a state rule to release, and
    // saying so explicitly keeps a stale entry from a previous action out of the map.
    ownership.delete(rule.id);
    await playback.stopContainer(container);
  } else if (spec.entry) {
    const sound = container.sounds.get(rule.action.soundId);
    if (!sound) return record(rule, how, "missingSound");
    ownership.set(rule.id, { containerId: container.id, soundId: sound.id });
    if (!sound.playing) await playback.playEntry(container, sound);
  } else {
    ownership.set(rule.id, { containerId: container.id, soundId: "" });
    if (!isOn(container)) await playback.playContainer(container);
  }
  record(rule, how, "ok");
}

/**
 * Let go of whatever a rule started, and nothing else.
 * @param {AutomationRule} rule
 * @returns {Promise<void>}
 */
async function release(rule) {
  const owned = ownership.get(rule.id);
  ownership.delete(rule.id);
  if (!owned) return;
  const container = game.playlists.get(owned.containerId);
  if (!isContainer(container)) return record(rule, "exit", "missingContainer");
  if (owned.soundId) {
    const sound = container.sounds.get(owned.soundId);
    if (sound?.playing) await playback.stopEntry(sound);
  } else if (isOn(container)) {
    await playback.stopContainer(container);
  }
  record(rule, "exit", "ok");
}

/* -------------------------------------------- */
/*  Evaluation                                  */
/* -------------------------------------------- */

/**
 * A sweep in progress, and whether the world changed again while it ran.
 *
 * Every caller of evaluateStates() is a hook, and a hook cannot await. Two scene writes landing in
 * quick succession — a darkness slider being dragged in Scene Config, or a weather change followed
 * immediately by another — would otherwise start two sweeps that both read `activeStates` before
 * either had written to it, and both fire the same rule. Serialising is the whole fix; the trailing
 * flag is what stops the second change from being dropped instead.
 */
let sweeping = null;
let sweepAgain = false;

/**
 * Re-check every state rule against the world as it is now, and act on the ones that changed side.
 *
 * Level-triggered here, edge-triggered in effect: the whole list is re-read every time, so arming
 * the engine or loading a world already in the dark starts the night bed rather than waiting for
 * darkness to move again. `activeStates` is what turns that sweep back into two events.
 *
 * Rules are walked in list order and awaited one at a time, because list order *is* the priority
 * the GM set by dragging, and a stop that must precede a play only precedes it if the two are
 * sequenced.
 * @returns {Promise<void>}
 */
export async function evaluateStates() {
  if (sweeping) {
    sweepAgain = true;
    return sweeping;
  }
  sweeping = (async () => {
    try {
      do {
        sweepAgain = false;
        await sweep();
      } while (sweepAgain);
    } finally {
      sweeping = null;
    }
  })();
  return sweeping;
}

/**
 * One pass over the state rules. Never called directly — evaluateStates() is what guarantees only
 * one of these is ever in flight.
 * @returns {Promise<void>}
 */
async function sweep() {
  if (!isRunning()) return;
  const scene = activeScene();
  for (const rule of getRules()) {
    if (!rule.isState) continue;
    const on = rule.enabled && stateMatches(rule, scene);
    if (on === (activeStates.get(rule.id) === true)) continue;
    activeStates.set(rule.id, on);
    if (on) await fire(rule, "enter");
    else await release(rule);
  }
}

/**
 * Fire every enabled event rule of one trigger type, in list order.
 * @param {string} type A TRIGGER_TYPES value.
 * @returns {Promise<void>}
 */
async function fireEvent(type) {
  if (!isRunning()) return;
  for (const rule of getRules()) {
    if (rule.isState || (rule.trigger.type !== type)) continue;
    if (!rule.enabled) continue;
    await fire(rule, "event");
  }
}

/* -------------------------------------------- */
/*  Public surface                              */
/* -------------------------------------------- */

/**
 * The log, newest first. A copy: the console renders it, and nothing outside this file may edit it.
 * @returns {{ruleId: string, at: number, how: string, outcome: string}[]}
 */
export function getLog() {
  return [...log];
}

/**
 * Whether a rule is currently inside its condition — the dot the automation list shows beside a
 * state rule. Always false for an event rule, which has no condition to be inside.
 * @param {string} ruleId
 * @returns {boolean}
 */
export function isRuleActive(ruleId) {
  return activeStates.get(ruleId) === true;
}

/**
 * Fire one rule now, whatever the world is doing — the list's "Test" button.
 *
 * Deliberately ignores both the armed switch and the rule's own condition: the question it answers
 * is "does this rule do what I meant?", and staging real rain to find out is exactly the friction
 * it exists to remove. It does not ignore `enabled`, because a disabled rule is one the GM has
 * said they do not want to hear.
 * @param {string} ruleId
 * @returns {Promise<void>}
 */
export async function testRule(ruleId) {
  const rule = getRule(ruleId);
  if (!rule || !rule.enabled) return;
  await fire(rule, "test");
}

/**
 * Re-read everything after the rule list or the armed switch changed.
 *
 * Disarming clears the bookkeeping without stopping anything. That is the deliberate answer: the
 * GM disarming mid-session is taking the mixer back, not asking for silence — and dropping
 * ownership at the same moment is what stops a later re-arm from stopping a bed the GM has since
 * made their own. Re-arming evaluates from scratch, so whatever currently matches starts again.
 * @returns {Promise<void>}
 */
export async function refresh() {
  if (!isArmed()) {
    activeStates.clear();
    ownership.clear();
  } else {
    // A deleted rule is never visited by a sweep again, so its bookkeeping would sit in these maps
    // for the rest of the session. Its audio is deliberately left playing — same answer as
    // disarming: removing a rule takes away the automation, not the sound the table is listening
    // to, and there is no undo for stopping it.
    const live = new Set(getRules().map(rule => rule.id));
    for (const id of activeStates.keys()) if (!live.has(id)) activeStates.delete(id);
    for (const id of ownership.keys()) if (!live.has(id)) ownership.delete(id);
  }
  await evaluateStates();
  foundry.helpers.Hooks.callAll(AUTOMATION_CHANGED_HOOK);
}

/**
 * Register the world hooks. GM-only, like the rest of the module, and guarded so a second call is
 * a no-op.
 * @returns {Promise<void>}
 */
export async function initAutomation() {
  if (registered) return;
  registered = true;

  const Hooks = foundry.helpers.Hooks;

  // Weather, darkness and scene activation all arrive as a Scene write, which is the only source
  // of truth for any of them and reaches every client. `active` is in the test so that switching
  // the table to another scene re-evaluates against the new one; the guard above it means the
  // scene being deactivated is ignored, since the scene now becoming active fires its own update.
  Hooks.on("updateScene", (scene, changed) => {
    if (!scene.active) return;
    const touched = ("weather" in changed)
      || ("active" in changed)
      || foundry.utils.hasProperty(changed, "environment.darknessLevel");
    if (touched) evaluateStates();
  });

  // "The encounter started" as a transition this client observed, rather than as a single update
  // that a rewind to round 1 would also produce. See combatRounds.
  Hooks.on("createCombat", combat => combatRounds.set(combat.id, combat.round ?? 0));
  Hooks.on("updateCombat", combat => {
    const before = combatRounds.get(combat.id) ?? 0;
    const now = combat.round ?? 0;
    combatRounds.set(combat.id, now);
    if (combat.active && (before < 1) && (now >= 1)) fireEvent(TRIGGER_TYPES.COMBAT_START);
  });
  // Deleting the encounter is the only observable "combat is over" in Foundry — there is no
  // end-combat concept, and the tracker's own control deletes the document.
  Hooks.on("deleteCombat", combat => {
    combatRounds.delete(combat.id);
    if (combat.active) fireEvent(TRIGGER_TYPES.COMBAT_END);
  });

  // Seed from the world as found, so a combat already past round 1 when this client connected is
  // not read as having just started the next time anything updates it.
  for (const combat of game.combats) combatRounds.set(combat.id, combat.round ?? 0);

  // The clock. Fires on every advance, however small; the sweep is cheap and edge-triggered, so a
  // minute ticking by inside the same hour changes nothing.
  Hooks.on("updateWorldTime", () => evaluateStates());

  await evaluateStates();
  console.debug(`${MODULE_ID} | automation engine ready`);
}
