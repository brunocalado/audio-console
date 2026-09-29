# 0.0.5

### Fixed

* **Library scrolling after playing a track.** Clicking a row in the Library tab no longer pins the list to that row: the mouse wheel and scrollbar move freely again, with no need to switch the filter to unstick it.


# 0.0.4

### Changed

* **Releases are published on GitHub.** Each version now comes as a GitHub release with its own `module.zip`, and it is registered on foundryvtt.com automatically. The zip holds only what the module needs to run, so it no longer carries the README's screenshots.

  **The manifest URL changed** to `https://github.com/brunocalado/audio-console/releases/latest/download/module.json`. Installs from the old URL still update, since the last `module.json` on `main` points to the new location.


# 0.0.3

### Added

* **Drag from the library picker.** Drag rows from **Add from Library** onto a playlist, soundboard or ambience card to add them there, or onto an empty part of the list to create a new one.
* **Soundboards as a list.** Each board can be shown as a grid of pads or as a list, with a visible Configure button on every row.

### Changed

* The library picker opens faster on large libraries, since it only draws the rows on screen.


# 0.0.2

### Added

* **Pad configuration.** Right-click a pad to set its name, icon, colour, volume and playback. The dialog also shows the sound's duration.
* **Board background colour.** Give each soundboard its own background tint, which its pop-out window keeps too.
* **Select a whole folder** in the library picker with one click.

### Changed

* **Play once, loop, or random interval.** Pads and ambience layers now pick one of three playback modes. A random interval is set as a minimum and a maximum wait in seconds, instead of an interval and a variance.

### Fixed

* Files with `#`, `&`, `+`, `?` or similar characters in their name or folder were shown as **Missing** and could not be previewed, even though they played fine.
