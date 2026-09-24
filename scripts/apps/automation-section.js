/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import {
  ACTIONS,
  ACTION_TYPES,
  CONTAINER_KINDS,
  DARKNESS_OPERATORS,
  TRIGGER_TYPES
} from "../constants.js";
import { containerKindOf, getContainers, getEntries } from "../data/repository.js";
import { getLog, isRuleActive, testRule } from "../automation/engine.js";
import {
  AutomationRule,
  createRule,
  deleteRule,
  getRule,
  getRules,
  isArmed,
  moveRule,
  setArmed,
  updateRule
} from "../automation/rules.js";
import { promptAutomationRule } from "./dialogs.js";

// The Automation section's context and click handlers, kept out of console-normal.js — which is
// already the largest file in the module and gains nothing from holding a sixth section's worth of
// string-building.
//
// The handlers are plain functions rather than static class members because ApplicationV2 invokes
// an action with `this` bound to the application instance, so they behave identically to the
// handlers declared inside the class and can simply be spread into its `actions` map.

/**
 * The weather list, built exactly the way the Scene Config's own Weather field builds it —
 * `Object.entries(CONFIG.weatherEffects)` mapped through `localize` (v14.367,
 * client/applications/sheets/scene-config.mjs:180-183).
 *
 * Read at render time rather than captured in a constant, so the two lists cannot drift: whatever
 * a GM can select on a scene is what they can write a rule about, without this module knowing or
 * caring which package registered it.
 *
 * The one deliberate difference from the scene's field is the blank entry. A blank StringField
 * makes core render an option with no text at all (common/data/fields.mjs:1813); an unlabelled row
 * in a scene sheet reads as "leave this alone", but in a rule editor it is a condition the GM is
 * choosing on purpose, so it gets words.
 * @returns {Record<string, string>}
 */
export function weatherChoices() {
  const choices = { "": game.i18n.localize("AUDIO_CONSOLE.Automation.NoWeather") };
  for (const [key, value] of Object.entries(CONFIG.weatherEffects ?? {})) {
    choices[key] = game.i18n.localize(value.label);
  }
  return choices;
}

/**
 * Every scene, by name — what a SCENE rule can be about. The active one is the natural default
 * for a new rule, so it sorts first.
 * @returns {Record<string, string>}
 */
function sceneChoices() {
  const scenes = [...game.scenes].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  return Object.fromEntries(scenes.map(scene => [scene.id, scene.name]));
}

/** @returns {Record<string, string>} */
function triggerChoices() {
  return Object.fromEntries(Object.values(TRIGGER_TYPES)
    .map(type => [type, game.i18n.localize(`AUDIO_CONSOLE.Automation.Trigger.${type}`)]));
}

/**
 * The action select, in two labelled groups.
 *
 * Eight flat options is a list to read; two groups of four is a list to scan. The split is the one
 * distinction that is actually load-bearing when choosing — am I starting something or silencing
 * something — and it comes straight off the ACTIONS table rather than being a second thing to keep
 * in step.
 * @returns {{label: string, options: Record<string, string>}[]}
 */
function actionGroups() {
  const groups = { play: {}, stop: {} };
  for (const [type, spec] of Object.entries(ACTIONS)) {
    groups[spec.stop ? "stop" : "play"][type] = game.i18n.localize(`AUDIO_CONSOLE.Automation.Action.${type}`);
  }
  return Object.entries(groups).map(([key, options]) => ({
    label: game.i18n.localize(`AUDIO_CONSOLE.Automation.ActionGroup.${key}`),
    options
  }));
}

/** @returns {Record<string, string>} */
function operatorChoices() {
  return Object.fromEntries(Object.values(DARKNESS_OPERATORS)
    .map(op => [op, game.i18n.localize(`AUDIO_CONSOLE.Automation.Operator.${op}`)]));
}

/**
 * Every container a rule may point at — the three the GM builds, never the Now Playing queue.
 * The queue is scratch space that bootstrap empties on every world load, so a rule aimed at it
 * would name something guaranteed to be gone.
 * @returns {Playlist[]}
 */
function ruleTargets() {
  return [
    ...getContainers(CONTAINER_KINDS.PLAYLIST),
    ...getContainers(CONTAINER_KINDS.SOUNDBOARD),
    ...getContainers(CONTAINER_KINDS.AMBIENCE)
  ];
}

/**
 * Whether a rule could be pointed at anything at all. STOP_ALL needs no target, so a world with no
 * containers yet can still hold that one rule — which is why this asks about the actions that DO
 * need a target rather than just counting containers.
 * @returns {boolean}
 */
function hasAnyTarget() {
  return ruleTargets().length > 0;
}

/* -------------------------------------------- */
/*  Describing a rule                           */
/* -------------------------------------------- */

/**
 * A darkness threshold as the GM reads it. The scene shows darkness as a 0–1 slider, so a
 * percentage is a translation — but it is the one every other level in this module is spoken in,
 * and "60%" is legible where "0.6" is a setting.
 * @param {number} value
 * @returns {string}
 */
function percent(value) {
  return `${Math.round(value * 100)}%`;
}

/**
 * One line of plain language for a rule's trigger.
 * @param {AutomationRule} rule
 * @returns {string}
 */
function describeTrigger(rule) {
  const { type, weather, operator, threshold, sceneId, fromHour, toHour } = rule.trigger;
  switch (type) {
    case TRIGGER_TYPES.WEATHER:
      return game.i18n.format("AUDIO_CONSOLE.Automation.TriggerText.Weather", {
        weather: weatherChoices()[weather] ?? weather
      });
    case TRIGGER_TYPES.DARKNESS:
      return game.i18n.format(operator === DARKNESS_OPERATORS.AT_LEAST
        ? "AUDIO_CONSOLE.Automation.TriggerText.DarknessAtLeast"
        : "AUDIO_CONSOLE.Automation.TriggerText.DarknessBelow", { value: percent(threshold) });
    case TRIGGER_TYPES.SCENE:
      return game.i18n.format("AUDIO_CONSOLE.Automation.TriggerText.Scene", {
        scene: game.scenes.get(sceneId)?.name ?? game.i18n.localize("AUDIO_CONSOLE.Automation.Missing")
      });
    case TRIGGER_TYPES.TIME:
      return game.i18n.format("AUDIO_CONSOLE.Automation.TriggerText.Time", { from: hourLabel(fromHour), to: hourLabel(toHour) });
    default:
      return game.i18n.localize(`AUDIO_CONSOLE.Automation.TriggerText.${type}`);
  }
}

/** @param {number} hour @returns {string} "20:00" — the clock face, not a bare number. */
function hourLabel(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * One line of plain language for a rule's action, plus whether the rule can actually run as
 * written.
 *
 * Three sentence shapes cover all eight actions, because the container's own name already says
 * which kind it is — "Stop “Chuva”" needs no word for *ambience* in front of it. So the text keys
 * are keyed by shape, not by action, and adding a ninth action needs no new string.
 *
 * Two different faults land on the same flag, because they have the same consequence and the same
 * fix — open the rule and pick a new target. One is a container the GM deleted, the most likely
 * reason a rule quietly stops working. The other is a container whose kind changed under it: the
 * dialog cannot build "play the whole soundboard", but re-flagging an existing target can leave a
 * stored rule saying exactly that, and the engine refuses it at fire time. A row that refuses to
 * fire has to look like one.
 * @param {AutomationRule} rule
 * @returns {{text: string, missing: boolean}}
 */
function describeAction(rule) {
  const spec = ACTIONS[rule.action.type];
  if (!spec) return { text: game.i18n.localize("AUDIO_CONSOLE.Automation.Missing"), missing: true };

  // The one action with no target to name or to have lost.
  if (!spec.kind) {
    return { text: game.i18n.localize("AUDIO_CONSOLE.Automation.ActionText.stopAll"), missing: false };
  }

  const container = game.playlists.get(rule.action.containerId);
  const missingLabel = game.i18n.localize("AUDIO_CONSOLE.Automation.Missing");
  const containerName = container?.name ?? missingLabel;
  const wrongKind = !!container && (containerKindOf(container) !== spec.kind);

  if (spec.entry) {
    const sound = container?.sounds.get(rule.action.soundId);
    return {
      text: game.i18n.format("AUDIO_CONSOLE.Automation.ActionText.entry", {
        sound: sound?.name ?? missingLabel,
        container: containerName
      }),
      missing: !container || !sound || wrongKind
    };
  }

  return {
    text: game.i18n.format(`AUDIO_CONSOLE.Automation.ActionText.${spec.stop ? "stop" : "play"}`,
      { container: containerName }),
    missing: !container || wrongKind
  };
}

/* -------------------------------------------- */
/*  Context                                     */
/* -------------------------------------------- */

/**
 * Everything the automation.hbs part draws.
 * @returns {object}
 */
export function prepareAutomationContext() {
  const rules = getRules();
  const armed = isArmed();

  const ruleRows = rules.map(rule => {
    const action = describeAction(rule);
    return {
      id: rule.id,
      enabled: rule.enabled,
      trigger: describeTrigger(rule),
      action: action.text,
      // A scene rule whose scene is gone is as broken as one whose container is.
      missing: action.missing || ((rule.trigger.type === TRIGGER_TYPES.SCENE) && !game.scenes.get(rule.trigger.sceneId)),
      // Only a state rule can be "currently on"; an event rule has no condition to be inside, so
      // it never shows the dot and the template does not have to know why.
      isState: rule.isState,
      active: rule.isState && isRuleActive(rule.id)
    };
  });

  const byId = new Map(rules.map(rule => [rule.id, rule]));
  const log = getLog().map(entry => {
    const rule = byId.get(entry.ruleId);
    return {
      // A rule deleted since it fired still has a line in the log; it just cannot name itself any
      // more. Dropping the line instead would quietly rewrite what the GM watched happen.
      name: rule ? describeTrigger(rule) : game.i18n.localize("AUDIO_CONSOLE.Automation.Missing"),
      time: new Date(entry.at).toLocaleTimeString(),
      how: game.i18n.localize(`AUDIO_CONSOLE.Automation.Log.How.${entry.how}`),
      outcome: entry.outcome === "ok" ? "" : game.i18n.localize(`AUDIO_CONSOLE.Automation.Log.Outcome.${entry.outcome}`),
      failed: entry.outcome !== "ok"
    };
  });

  return {
    armed,
    rules: ruleRows,
    enabledCount: ruleRows.filter(rule => rule.enabled).length,
    log,
    // Automation runs on exactly one client. A second GM looking at this window is looking at a
    // list that something else is executing, and the section says so rather than letting them
    // wonder why "Armed" changes nothing on their screen.
    isDriver: game.users.activeGM?.isSelf === true,
    hasTargets: hasAnyTarget()
  };
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

/**
 * Open the rule editor on a rule, and hand back what the GM entered.
 * @param {AutomationRule|null} rule Null for a new rule.
 * @returns {Promise<object|null>}
 */
async function editRuleDialog(rule) {
  const containers = ruleTargets().map(container => ({
    id: container.id,
    name: container.name,
    // The dialog filters the target list by the chosen action, so it needs each container's kind.
    kind: containerKindOf(container),
    sounds: getEntries(container).map(sound => ({ id: sound.id, name: sound.name }))
  }));
  // "Stop everything" names no container, so it is the one rule a world with no containers can
  // still hold; only a rule that would have to pick a target is refused here.
  const needsTarget = rule ? !!ACTIONS[rule.action.type]?.kind : false;
  if (!containers.length && needsTarget) {
    ui.notifications.warn("AUDIO_CONSOLE.Automation.Notify.NoTargets", { localize: true });
    return null;
  }
  return promptAutomationRule({
    // A brand-new rule is described by the schema's own initials rather than by a second copy of
    // the defaults written out here — one source for what a fresh rule looks like.
    rule: rule ? rule.toObject() : new AutomationRule({}).toObject(),
    weatherChoices: weatherChoices(),
    sceneChoices: sceneChoices(),
    triggerChoices: triggerChoices(),
    actionGroups: actionGroups(),
    operatorChoices: operatorChoices(),
    containers,
    actions: ACTIONS,
    isNew: !rule
  });
}

/**
 * Arm or disarm the engine. A world setting write, so every open console — and the GM actually
 * driving the rules — learns about it through the setting's own onChange rather than from here.
 * @this {AudioConsoleNormal}
 */
async function onToggleArmed() {
  await setArmed(!isArmed());
}

/** @this {AudioConsoleNormal} */
async function onNewRule() {
  const data = await editRuleDialog(null);
  if (!data) return;
  await createRule(data);
}

/** @this {AudioConsoleNormal} */
async function onEditRule(event, target) {
  const rule = getRule(target.dataset.ruleId);
  if (!rule) return;
  const data = await editRuleDialog(rule);
  if (!data) return;
  await updateRule(rule.id, data);
}

/** @this {AudioConsoleNormal} */
async function onDeleteRule(event, target) {
  await deleteRule(target.dataset.ruleId);
}

/**
 * Enable or disable one rule. A disabled state rule that was inside its condition is released by
 * the engine's own re-evaluation, because `enabled` is part of what `stateMatches` is asked — so
 * switching a rule off stops what it started, without this handler knowing that.
 * @this {AudioConsoleNormal}
 */
async function onToggleRule(event, target) {
  const rule = getRule(target.dataset.ruleId);
  if (!rule) return;
  await updateRule(rule.id, { enabled: !rule.enabled });
}

/** @this {AudioConsoleNormal} */
async function onTestRule(event, target) {
  await testRule(target.dataset.ruleId);
}

/**
 * The click handlers this section contributes, ready to be spread into the console's `actions`.
 */
export const AUTOMATION_ACTIONS = {
  automationToggleArmed: onToggleArmed,
  automationNewRule: onNewRule,
  automationEditRule: onEditRule,
  automationDeleteRule: onDeleteRule,
  automationToggleRule: onToggleRule,
  automationTestRule: onTestRule
};

/* -------------------------------------------- */
/*  Reordering                                  */
/* -------------------------------------------- */

/**
 * Drag-to-reorder for the rule list.
 *
 * Not `foundry.utils.performIntegerSort`, which the entry lists use: that exists to renumber a
 * `sort` field on documents that have no inherent order. A rule's priority *is* its index in a
 * stored array, so the move is a splice and there is no field to renumber.
 * @param {HTMLElement} list The `[data-rule-list]` element.
 * @param {{get: () => string|null, set: (id: string|null) => void}} dragged Where to keep the id
 *   mid-drag; the console owns it so it survives the re-render a drop causes.
 */
export function bindRuleListDrag(list, dragged) {
  list.addEventListener("dragstart", event => {
    const row = event.target.closest("[data-rule-id]");
    if (!row) return;
    dragged.set(row.dataset.ruleId);
    event.dataTransfer.effectAllowed = "move";
    // Firefox will not start a drag at all unless some data is set, and this payload is never
    // read: the id travels in `dragged`, because a rule id is meaningless to every other drop
    // target in Foundry and must not look like something they can accept.
    event.dataTransfer.setData("text/plain", "");
  });

  list.addEventListener("dragover", event => {
    const row = event.target.closest("[data-rule-id]");
    if (!row || !dragged.get()) return;
    event.preventDefault();
    const before = (event.clientY - row.getBoundingClientRect().top) < (row.offsetHeight / 2);
    row.classList.toggle("drag-over-before", before);
    row.classList.toggle("drag-over-after", !before);
  });

  list.addEventListener("dragleave", event => {
    event.target.closest("[data-rule-id]")?.classList.remove("drag-over-before", "drag-over-after");
  });

  list.addEventListener("dragend", () => {
    dragged.set(null);
    clearIndicators(list);
  });

  list.addEventListener("drop", async event => {
    const row = event.target.closest("[data-rule-id]");
    const draggedId = dragged.get();
    clearIndicators(list);
    dragged.set(null);
    if (!row || !draggedId || (row.dataset.ruleId === draggedId)) return;
    event.preventDefault();

    const order = getRules().map(rule => rule.id);
    const from = order.indexOf(draggedId);
    let to = order.indexOf(row.dataset.ruleId);
    if ((from === -1) || (to === -1)) return;
    const before = (event.clientY - row.getBoundingClientRect().top) < (row.offsetHeight / 2);
    if (!before) to += 1;
    // Removing the dragged row first shifts everything after it down by one, so a target that sat
    // below the source has to come down with it or the rule lands one slot too far.
    if (from < to) to -= 1;
    await moveRule(draggedId, to);
  });
}

/** @param {HTMLElement} list */
function clearIndicators(list) {
  for (const el of list.querySelectorAll(".drag-over-before, .drag-over-after")) {
    el.classList.remove("drag-over-before", "drag-over-after");
  }
}
