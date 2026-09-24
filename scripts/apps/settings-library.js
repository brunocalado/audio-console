/*!
 * Audio Console
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID } from "../constants.js";
import { normalizePath } from "../helpers.js";
import * as library from "../library/index.js";
import { planConsolidation, runConsolidation } from "../library/consolidate.js";
// The API, not mutations.js: syncing a pack is something a module could do too, and this app is
// one more consumer of the same surface — the same discipline as going through library/index.js.
import { getPacks, syncPack } from "../api.js";
import {
  confirmConsolidate,
  confirmReplaceImport,
  confirmSyncPack,
  openConsolidateProgress,
  promptExportFirst,
  promptImport,
  showConsolidationReport
} from "./dialogs.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The library's recovery and moving-installation tools — Consolidate, Export, Import. Reached
 * from Foundry's own Settings tab via `game.settings.registerMenu` (settings.js)
 * rather than a toolbar button on the console: these are used rarely, by design, and a button that
 * lives on every render of the daily-use Library tab was confusing more than it helped. Everything
 * here goes through library/index.js — this app never reads or writes library.json itself, same
 * discipline console-normal.js followed when this lived there.
 */
export class LibraryMaintenanceSettings extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-library-maintenance`,
    classes: [MODULE_ID, "ac-settings-library"],
    window: {
      title: "AUDIO_CONSOLE.Settings.LibraryMaintenance.Title",
      icon: "fa-solid fa-screwdriver-wrench"
    },
    position: { width: 520, height: "auto" },
    actions: {
      consolidateLibrary: LibraryMaintenanceSettings.#onConsolidateLibrary,
      exportLibrary: LibraryMaintenanceSettings.#onExportLibrary,
      importLibrary: LibraryMaintenanceSettings.#onImportLibrary,
      syncPack: LibraryMaintenanceSettings.#onSyncPack
    }
  };

  /** @override */
  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/settings/library-maintenance.hbs` }
  };

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.packs = getPacks().map(pack => ({ id: pack.id, name: pack.name, containers: pack.containers.length }));
    return context;
  }

  /**
   * The two operations people run once and regret twice both stop here first.
   * @param {string} key The localisation key for the question.
   * @returns {Promise<boolean>} Whether to go ahead.
   */
  async #offerExportFirst(key) {
    const choice = await promptExportFirst({ question: game.i18n.localize(key) });
    if (!choice) return false;
    if (choice === "export") library.exportCopy();
    return true;
  }

  /**
   * The only backup: a copy outside the data folder entirely. Nothing inside the data folder
   * duplicates library.json, so this is the whole of the safety net.
   */
  static #onExportLibrary() {
    library.exportCopy();
    ui.notifications.info(game.i18n.localize("AUDIO_CONSOLE.Library.Maintenance.Notify.Exported"));
  }

  /**
   * Read a catalogue from this machine and either merge it in or replace what is here. Neither
   * mode verifies that the files exist: a path absent on this machine may be present on the next
   * one, and dropping it would destroy exactly the tags the import was for.
   * @this {LibraryMaintenanceSettings}
   */
  static async #onImportLibrary() {
    const picked = await promptImport();
    if (!picked) return;

    let rows = null;
    try {
      rows = library.parseCatalogue(JSON.parse(await foundry.utils.readTextFromFile(picked.file)));
    } catch (err) {
      console.warn(`${MODULE_ID} | could not read the imported catalogue`, err);
    }
    if (!rows) {
      ui.notifications.error(game.i18n.localize("AUDIO_CONSOLE.Library.Maintenance.Notify.ImportInvalid"));
      return;
    }

    if (picked.mode === "merge") {
      const { added, merged } = library.mergeEntries(rows);
      await library.flushSave();
      ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.Library.Maintenance.Notify.Merged", { added, merged }));
      return;
    }

    const incoming = new Set(rows.map(row => normalizePath(row.path)));
    const removedCount = library.getAllEntries().filter(entry => !incoming.has(entry.path)).length;
    const confirmed = await confirmReplaceImport({
      currentCount: library.getAllEntries().length,
      incomingCount: rows.length,
      removedCount
    });
    if (!confirmed) return;
    if (!await this.#offerExportFirst("AUDIO_CONSOLE.Library.Maintenance.ExportFirstReplace")) return;

    const count = library.replaceAll(rows);
    await library.flushSave();
    ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.Library.Maintenance.Notify.Replaced", { count }));
  }

  /**
   * Take a newer pack version's changes. The API's pack runner is add-only on every load, so this
   * is the one place a pack gets to overwrite anything — and only after the GM has read what it
   * will and will not touch.
   * @this {LibraryMaintenanceSettings}
   */
  static async #onSyncPack(event, target) {
    const pack = getPacks().find(p => p.id === target.dataset.packId);
    if (!pack) return;
    if (!await confirmSyncPack({ name: pack.name, containers: pack.containers.length })) return;
    let counts;
    try {
      counts = await syncPack(pack.id);
    } catch (err) {
      console.error(`${MODULE_ID} | sync of pack "${pack.id}" failed`, err);
      ui.notifications.error(game.i18n.format("AUDIO_CONSOLE.Settings.LibraryMaintenance.Packs.Notify.Failed", { name: pack.name }));
      return;
    }
    ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.Settings.LibraryMaintenance.Packs.Notify.Synced", { name: pack.name, ...counts }));
  }

  /**
   * Copy every library file into the module's data folder under a kebab-case name. The most
   * destructive thing in the module: the copies and the originals both stay on disk permanently,
   * because Foundry's file API has no delete. Preview first, always.
   * @this {LibraryMaintenanceSettings}
   */
  static async #onConsolidateLibrary() {
    if (!library.getAllEntries().length) {
      ui.notifications.info(game.i18n.localize("AUDIO_CONSOLE.Library.Consolidate.Notify.EmptyLibrary"));
      return;
    }
    // Planning HEADs every candidate file to total the bytes, which is a round trip each — worth
    // saying out loud on a large library rather than leaving the window looking hung.
    ui.notifications.info(game.i18n.localize("AUDIO_CONSOLE.Library.Consolidate.Notify.Planning"));
    const plan = await planConsolidation();
    if (!plan.copies.length) {
      ui.notifications.info(game.i18n.format("AUDIO_CONSOLE.Library.Consolidate.Notify.NothingToDo", {
        count: plan.skipped.length
      }));
      return;
    }
    if (!await confirmConsolidate(plan)) return;
    if (!await this.#offerExportFirst("AUDIO_CONSOLE.Library.Maintenance.ExportFirstConsolidate")) return;

    const progress = openConsolidateProgress({ total: plan.copies.length });
    await progress.ready;
    let report;
    try {
      report = await runConsolidation(plan, {
        onProgress: progress.update,
        shouldCancel: progress.isCancelled
      });
    } finally {
      await progress.close();
    }
    await showConsolidationReport(report);
  }
}
