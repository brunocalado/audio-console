# Audio Console — Public API

Audio Console exposes a small **setup API** so a content module — or a GM's script macro — can
build what the GM would otherwise assemble by hand in the console window: audio files registered
in the library with tags and a channel, playlists / soundboards / ambiences created in their
section folders, and every sound configured on the way in (volume, loop, pad icon and colour,
random-interval scheduler). The GM opens the console and it is all there.

It is a setup API, not an editing one. There are no update or remove calls; the console window is
for that.

- **GM-only.** Every call throws for a non-GM user.
- **After `ready`.** The library is loaded in the `ready` hook; a call before that throws.
- **Throws on bad input.** Every error names the argument and the accepted values.
- `globalThis.AudioConsole` and `game.modules.get("audio-console").api` are the same object.

**Add-only, by design.** A registered pack is built on every world load, so it never rewrites a
thing that already exists: a container that is there is reused, sounds already in it are left
exactly as they are, and a library row already catalogued keeps its name, channel and volume
(it only gains the pack's tags). Running the same registration twice is a no-op; a newer pack
version that adds three sounds adds exactly those three. The way a pack's *changes* reach a world
that already has it is the GM pressing **Sync** — see [Sync](#sync).

## For content module authors

Register what you ship from your own `setup` hook. Audio Console builds it once the library is
loaded; you write no `ready` hook and no import call of your own. `setup`, not `init`: Foundry
runs every module's `init` in script order, so at your `init` the `AudioConsole` global may not
exist yet — by `setup` it always does.

```js
Hooks.once("setup", () => {
  AudioConsole.registerPack({
    id: "my-adventure-audio",          // your module's id, exactly as in module.json
    name: "My Adventure — Audio",      // what the GM sees in Library Maintenance
    containers: [
      {
        kind: "soundboard",
        name: "Tavern",
        channel: "environment",
        tags: ["tavern", "my-adventure"],
        sounds: [
          { path: "modules/my-adventure-audio/audio/door.ogg", icon: "modules/my-adventure-audio/icons/door.webp" },
          { path: "modules/my-adventure-audio/audio/cheer.ogg", volume: 0.6, color: "#c08a2e" },
          { path: "modules/my-adventure-audio/audio/mug.ogg", random: { enabled: true, interval: 45, variance: 0.5 } }
        ]
      },
      {
        kind: "ambience",
        name: "Tavern Night",
        fade: 2000,
        tags: ["tavern", "my-adventure"],
        sounds: [
          { path: "modules/my-adventure-audio/audio/crowd.ogg", channel: "environment", volume: 0.5 },
          { path: "modules/my-adventure-audio/audio/lute.ogg", channel: "music", volume: 0.4 },
          { path: "modules/my-adventure-audio/audio/thunder.ogg", channel: "environment", repeat: false,
            random: { enabled: true, interval: 90, variance: 0.6 } }
        ]
      }
    ]
  });
});
```

Add Audio Console to your manifest so Foundry refuses to enable your module without it:

```json
"relationships": { "requires": [{ "id": "audio-console", "type": "module" }] }
```

Specs are validated at registration, so a mistake surfaces in your console at load rather than in
the GM's world later. A `registerPack` call with the same `id` replaces the earlier registration.

## `registerPack(pack)`

```js
AudioConsole.registerPack({ id, name, containers, library, folders, tagGroups })
```

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Your module's id. Must be an **active** module, or the call throws. |
| `name` | `string` | Shown to the GM in Settings → Audio Console → Library Maintenance. |
| `containers` | `ImportSpec[]` | One spec per container — the same shape `import()` takes. |
| `library` | `Entry[]` | Optional. Files to catalogue with tags and a channel but no container — alternate mixes, stems, anything the GM picks from the library rather than a board. The same shape [`library.add`](#libraryaddentries) takes. |
| `folders` | `Record<string, string>` | Optional. Folder path → the name the Library tab shows for it, for folders whose on-disk name is a slug: `{ "modules/my-pack/tracks/314-shuttle-crash": "Shuttle Crash #314" }`. A folder is still only what its files make it; this names it. |
| `tagGroups` | `Record<string, string>` | Optional. Tag → the facet it belongs to: `{ "fantasy": "genre", "scifi": "genre", "tension": "mood" }`. Tags sharing a group are **alternatives** in the library's filter — picking both widens the result — while tags in different groups narrow against each other. A tag you leave out stays ungrouped and narrows on its own. Group names are free text; nothing holds a list of permitted ones. |

Returns nothing and writes nothing. Once the library is loaded, every file the pack names — its
`library` entries and every container's sounds — is catalogued in one pass, the `folders` are named
(a folder that already has a name keeps it) and the `tagGroups` applied (a tag that already has a
group keeps it). Then every container is built through `import()` one at a time; a spec that fails
is logged with the pack id and container name, and the rest of the pack still builds.

## `import(spec)`

Build one container from a spec. What a registered pack runs per container, and what a macro
calls directly.

```js
const { container, created, added, skipped } = await AudioConsole.import(spec);
```

### The spec

| Field | Type | Default | Notes |
|---|---|---|---|
| `kind` | `"playlist" \| "soundboard" \| "ambience"` | — | Required. |
| `name` | `string` | — | Required. The container's name at creation. Renaming it later is the GM's business. |
| `color` | `"#rrggbb" \| null` | `null` | Accent colour in the console. |
| `favorite` | `boolean` | `false` | Pinned to the rail's Favorites list. |
| `fade` | `number \| null` | `null` | Crossfade in milliseconds. Playlists and ambiences. |
| `shuffle` | `boolean` | `false` | Playlists only; throws for the other kinds. |
| `channel` | `"music" \| "environment"` | `"music"` | Default channel for every sound that does not set its own. |
| `tags` | `string[]` | `[]` | Applied to every sound, in addition to the sound's own. |
| `sounds` | `Sound[]` | — | Required (may be empty). |

### A sound

| Field | Type | Default | Notes |
|---|---|---|---|
| `path` | `string` | — | Required. Any Foundry-servable path; a module's own `modules/<id>/…` is fine. Not checked for existence — the library marks missing files when it next looks. |
| `name` | `string` | from the filename | `"tavern-crowd.ogg"` → `"Tavern Crowd"`. |
| `channel` | `"music" \| "environment"` | the spec's | Which of the GM's volume sliders governs it. |
| `tags` | `string[]` | `[]` | Free text. Normalised to lowercase `a-z0-9-`, capped at 24 characters; anything shorter than 3 characters after that is dropped. |
| `volume` | `number` | `0.8` | `0`–`1`. |
| `repeat` | `boolean` | by kind | `true` for an ambience layer, `false` for a track or a pad — the console's own defaults. |
| `icon` | `string` | — | Soundboard pads: the image the pad face shows. Must be an image path. |
| `color` | `"#rrggbb" \| null` | `null` | Soundboard pads: the pad's accent colour. |
| `random` | `{ enabled, interval?, variance?, onStart? }` | off | Pads and ambience layers: fire at a random interval. `interval` in seconds (centre of the range, minimum 2, default 60); `variance` `0`–`1` as a fraction of the interval (default 0.5). `onStart` (ambience layers, default `false`): also play the moment the ambience starts; when off, the layer's first fire lands somewhere inside its first interval. |

### What it does

1. Finds the container — a pack's by its provenance, a macro's by name among containers no pack
   built — or creates it in its section folder.
2. Registers every sound's path in the library. A path already there keeps its row and gains the
   spec's tags.
3. Adds the sounds the container does not hold yet, configured from the spec. A path already in
   the container is left alone and listed in `skipped`.
4. Saves the library.

### Return value

| Field | Type | Notes |
|---|---|---|
| `container` | `Playlist` | The container, new or reused. |
| `created` | `boolean` | Whether this call created it. |
| `added` | `PlaylistSound[]` | The sounds this call added. |
| `skipped` | `string[]` | Paths already in the container. |

### Throws

Bad `kind`, `channel`, `volume`, `color`, `fade`, `random`; `shuffle` on a non-playlist; a
missing `name` or `path`; not a GM; called before `ready`. A non-image `icon` is refused by the
document itself and surfaces as that error.

### From a macro

```js
const result = await AudioConsole.import({
  kind: "playlist",
  name: "Boss Fights",
  shuffle: true,
  tags: ["combat", "boss"],
  sounds: [
    { path: "music/boss-1.ogg" },
    { path: "music/boss-2.ogg", volume: 0.7 }
  ]
});
ui.notifications.info(`${result.created ? "Created" : "Reused"} ${result.container.name}: ${result.added.length} added, ${result.skipped.length} already there`);
```

A container a macro builds carries no pack provenance and is never touched by Sync.

## `library.add(entries)`

Register files in the library — tags and channel included — without building a container. For a
pack that ships tagged audio and leaves the boards to the GM.

```js
const rows = await AudioConsole.library.add([
  { path: "modules/my-pack/audio/rain.ogg", channel: "environment", tags: ["weather", "rain"] },
  { path: "modules/my-pack/audio/wind.ogg", channel: "environment", tags: ["weather"], volume: 0.6 }
]);
```

Each entry takes `path`, `name`, `channel`, `tags`, `volume` as in [a sound](#a-sound). Returns
the rows actually added; a path already catalogued is not among them, but it does gain the
entry's tags.

## Sync

A pack's registration only ever adds. When a newer version of a pack changes something — a pad's
icon, a layer's volume, a board's colour — the GM takes those changes deliberately, from
**Settings → Audio Console → Library Maintenance → Content Packs → Sync**, after a dialog that
says what will be overwritten.

Sync finds the pack's containers by a provenance flag written at creation, never by name, so a
board the GM renamed is still the pack's board. It then applies **only the fields the pack's spec
defines**:

| Sync overwrites | Sync leaves alone |
|---|---|
| On the pack's sounds: `volume`, `repeat`, `name`, `channel`, `icon`, `color`, `random` — each only where the spec sets it, and inside `random` only the keys the spec sets | A sound the GM added to the pack's board |
| On the pack's containers: `color`, `favorite`, `fade`, `shuffle` | The container's name |
| On the pack's library rows (`library` and every container's sounds): `name`, `channel`, `volume` | Any container the GM built, whatever its name |
| Sounds the spec lists that the container lacks are added | Tags: they only ever merge, so a tag the GM added stays |
| A container the GM deleted is built again | A `random` key the spec leaves out — an `onStart` the GM switched on stays on |
| Folder names from `folders` | |
| Tag groups from `tagGroups` | |

For pack authors this means: **a field you omit from a spec is one the GM owns.** If your pack
has no opinion about a pad's volume, leave `volume` out and Sync will never touch it.

The same operation is available as `AudioConsole.syncPack(id)` for a macro, with the same rules
and no confirmation.

## In the library table

A pack's files all live under `modules/<id>/…`, so the Library tab's folder tree shows them under
one folder named with the module's title — not `modules` and then the id. Below that, a folder
shows the name `folders` gave it, or its path segment. Nothing about the path itself changes.

For a catalogue that is "one track, several mixes", this is the whole organisation: the track is
its folder, named and numbered, and its versions are the rows inside. No container is needed for
a track whose versions are alternatives rather than layers.

## Tag groups

Without a group, every selected tag narrows: asking for `fantasy` and `scifi` returns only what is
both. That is rarely the question a GM is asking — two tags from the same axis are alternatives,
not requirements.

`tagGroups` is what says which tags share an axis. In the Library tab's tag panel each group is its
own block, headed with the group's name and `(any)`, and the rule is:

- **Within a block** — OR. `fantasy` + `scifi` under `genre` means either.
- **Between blocks** — AND. `genre` + `mood` narrows.
- **Ungrouped** — a group of one, so it just narrows, exactly as every tag did before groups.

A chip that would filter the table down to nothing is drawn dead and cannot be clicked, so the
panel never offers a dead end.

Group them from the source taxonomy where you have one — the axes a catalogue already publishes
(genre, mood, setting, biome, action) are usually the right blocks. The GM can regroup any tag from
Manage Tags, and a group you did not set is never overwritten on a load, only on a Sync.

## How the library is saved

The library is not a Foundry document. It lives in `Data/audio-console/library.json`, shared by
every world on the installation, and is held in memory once loaded. Every API call that changes it
updates the in-memory catalogue and then forces the (normally debounced) write to disk before it
returns, so nothing extra is needed and a page reload right after a call loses nothing.

That file is **not part of a world backup**. Library Maintenance has Export for that.

## Not here, on purpose

- Editing or removing what exists — the console window does that.
- Playback — the console, hotbar pad macros and automation rules cover it.
- The Now Playing queue.
- Deleting files from disk.
