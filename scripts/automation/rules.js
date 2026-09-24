/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import {
  ACTION_TYPES,
  AUTOMATION_STATE_TRIGGERS,
  DARKNESS_OPERATORS,
  MODULE_ID,
  SETTINGS,
  TRIGGER_TYPES
} from "../constants.js";

// The rule list: its shape, and the one place it is read from and written to. Nothing here
// listens to anything or plays anything — engine.js does that, and it asks here for the list.
//
// Rules live in a world setting rather than on a document. They are not a property *of* any one
// container (a rule names a container the way a bookmark names a page), and there is no document
// in the world whose deletion should take a rule with it.

const fields = foundry.data.fields;

/**
 * One automation rule: a trigger and an action.
 *
 * Deliberately flat. A trigger's parameters all live side by side in `trigger` rather than in a
 * per-type sub-object, because a rule only ever uses the ones its own type reads and the rest cost
 * a few bytes — where a discriminated union would cost a branch in every reader.
 */
export class AutomationRule extends foundry.abstract.DataModel {
  static defineSchema() {
    return {
      id: new fields.StringField({
        required: true,
        blank: false,
        initial: () => foundry.utils.randomID()
      }),
      enabled: new fields.BooleanField({ initial: true }),

      trigger: new fields.SchemaField({
        type: new fields.StringField({
          required: true,
          blank: false,
          choices: Object.values(TRIGGER_TYPES),
          initial: TRIGGER_TYPES.WEATHER
        }),

        // A key of CONFIG.weatherEffects, or "" for the scene's "no weather" state — which is a
        // real state a GM selects, not the absence of a choice, so it is a legitimate thing to
        // watch for ("when the rain stops, let the plain bed back in").
        //
        // No `choices`, on purpose. The valid set is whatever is registered at the moment the
        // dropdown renders, which core alone does not decide: anything that adds a weather effect
        // adds a key here too. Pinning the list at schema-definition time would silently drop a
        // rule the moment the thing that registered its weather was not loaded yet — and an
        // unknown key simply never matches, which is the harmless failure.
        weather: new fields.StringField({ required: true, blank: true, initial: "" }),

        operator: new fields.StringField({
          required: true,
          blank: false,
          choices: Object.values(DARKNESS_OPERATORS),
          initial: DARKNESS_OPERATORS.AT_LEAST
        }),
        // Same field type the scene itself uses for darknessLevel, so the two are always
        // comparable without anything in between having to clamp or convert.
        threshold: new fields.AlphaField({ initial: 0.5 }),

        // SCENE: the Scene id whose activation is the condition. A plain id for the same reason
        // containerId below is: a deleted scene is a dangling id the list reports, not a failure
        // that throws the rule list out.
        sceneId: new fields.StringField({ required: true, blank: true, initial: "" }),

        // TIME: the hour window [fromHour, toHour) of the world calendar's day. A window whose end
        // is not after its start wraps past midnight, so 20 → 6 is "night" with no second rule.
        fromHour: new fields.NumberField({ required: true, nullable: false, integer: true, min: 0, max: 23, initial: 20 }),
        toHour: new fields.NumberField({ required: true, nullable: false, integer: true, min: 0, max: 23, initial: 6 })
      }),

      action: new fields.SchemaField({
        type: new fields.StringField({
          required: true,
          blank: false,
          choices: Object.values(ACTION_TYPES),
          initial: ACTION_TYPES.PLAY_PLAYLIST
        }),
        // A Playlist id. Not a ForeignDocumentField: this is setting data, not document data, so
        // there is no collection for that field to resolve against and a deleted container has to
        // be tolerated as a dangling id the UI reports rather than a validation failure that
        // throws the whole rule list out.
        containerId: new fields.StringField({ required: true, blank: true, initial: "" }),
        // A PlaylistSound id inside that container, for PLAY_ENTRY. Blank for the other actions.
        //
        // There is deliberately no fade here. Fade is not a property of the rule: `fadeDuration` is
        // `sound.fade ?? playlist.fade ?? 0` (v14.367, client/documents/playlist-sound.mjs:76), so
        // the only way a rule could carry one is by writing it onto the container — where it would
        // then govern every other thing that plays that container, including the GM by hand. A
        // container's fade belongs to the container, and is edited where it lives.
        soundId: new fields.StringField({ required: true, blank: true, initial: "" })
      })
    };
  }

  /**
   * Whether this rule's trigger describes a condition (which can be left) rather than a moment.
   * @type {boolean}
   */
  get isState() {
    return AUTOMATION_STATE_TRIGGERS.has(this.trigger.type);
  }
}

/* -------------------------------------------- */
/*  The list                                    */
/* -------------------------------------------- */

/**
 * Every rule, in the GM's own order.
 *
 * Order is the list's order and nothing else — no sort. It is the priority the GM set by dragging,
 * and it decides the sequence in which matching rules fire, which is the only thing order has to
 * decide now that several rules are allowed to fire at once.
 *
 * A stored entry that no longer validates is dropped rather than thrown: one malformed rule must
 * not take the other nine with it. The module is in alpha and the shape can still change, so this
 * is the path a renamed field takes — it disappears, and the GM makes it again.
 * @returns {AutomationRule[]}
 */
export function getRules() {
  const stored = game.settings.get(MODULE_ID, SETTINGS.AUTOMATION_RULES);
  if (!Array.isArray(stored)) return [];
  const rules = [];
  for (const raw of stored) {
    try {
      rules.push(new AutomationRule(raw));
    } catch (err) {
      console.warn(`${MODULE_ID} | dropping an unreadable automation rule`, raw, err);
    }
  }
  return rules;
}

/**
 * @param {string} id
 * @returns {AutomationRule|null}
 */
export function getRule(id) {
  return getRules().find(rule => rule.id === id) ?? null;
}

/**
 * Replace the whole list. Every mutation below funnels through here, so there is one write and one
 * place the engine's re-evaluation is triggered from.
 * @param {AutomationRule[]} rules
 * @returns {Promise<void>}
 */
export async function saveRules(rules) {
  await game.settings.set(MODULE_ID, SETTINGS.AUTOMATION_RULES, rules.map(rule => rule.toObject()));
}

/**
 * @param {object} data A partial rule; anything omitted takes its schema initial.
 * @returns {Promise<AutomationRule>} The rule as it was actually stored, id included.
 */
export async function createRule(data = {}) {
  const rule = new AutomationRule(data);
  await saveRules([...getRules(), rule]);
  return rule;
}

/**
 * @param {string} id
 * @param {object} changes A partial rule. Merged over the stored one, so a caller may send only
 *   the field it changed.
 * @returns {Promise<AutomationRule|null>} Null when there is no such rule.
 */
export async function updateRule(id, changes) {
  const rules = getRules();
  const index = rules.findIndex(rule => rule.id === id);
  if (index === -1) return null;
  // Through the model rather than by assignment: a merged object still has to be cleaned and
  // validated, and this is the only way a bad threshold is caught before it reaches the setting.
  const merged = new AutomationRule(foundry.utils.mergeObject(rules[index].toObject(), changes, { inplace: false }));
  rules[index] = merged;
  await saveRules(rules);
  return merged;
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteRule(id) {
  await saveRules(getRules().filter(rule => rule.id !== id));
}

/**
 * Move a rule to a new position in the list — the drag that sets priority.
 * @param {string} id
 * @param {number} toIndex Clamped, so a drop past either end lands at that end.
 * @returns {Promise<void>}
 */
export async function moveRule(id, toIndex) {
  const rules = getRules();
  const from = rules.findIndex(rule => rule.id === id);
  if (from === -1) return;
  const [moved] = rules.splice(from, 1);
  rules.splice(Math.clamp(toIndex, 0, rules.length), 0, moved);
  await saveRules(rules);
}

/* -------------------------------------------- */
/*  Armed state                                 */
/* -------------------------------------------- */

/**
 * @returns {boolean} Whether the engine is evaluating at all.
 */
export function isArmed() {
  return !!game.settings.get(MODULE_ID, SETTINGS.AUTOMATION_ARMED);
}

/**
 * @param {boolean} armed
 * @returns {Promise<void>}
 */
export async function setArmed(armed) {
  await game.settings.set(MODULE_ID, SETTINGS.AUTOMATION_ARMED, !!armed);
}
