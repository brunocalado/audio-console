# 0.0.8

### Added

* **Listen before you add.** Each track in the **Add from Library** window now has a headphones button, so you can hear a sound before you pick it for a soundboard, playlist or ambience. Click it again to stop. Only one track plays at a time, and a long file shows a spinner while it loads. Closing the window stops the preview.

### Fixed

* **A preview could start after you had stopped it.** Stopping a long file while it was still loading did nothing, and it began playing once it loaded, with no way to stop it.


# 0.0.7

### Added

* **Add to a Playlist from the Library.** A new button on each Library row sends the track to one of your playlists, or to a new one you name on the spot. The playlist you used last is offered first, so sending several tracks to the same one is quick.
* **Save Now Playing as a playlist.** A new **Save as Playlist** button at the top of Now Playing keeps the queue's tracks, in the same order, as a new playlist. The queue itself is still emptied every time the world loads.

### Changed

* The Library row's **Play** button is gone. Clicking the row already plays the track.
* The **Audio Console** button in the Playlists sidebar now sits on its own row, above Create Playlist and Create Folder.

### Fixed

* **The Playlists sidebar button flickered and ignored clicks** while an ambience was playing. Its random layers redraw the sidebar about once a second, and the button was rebuilt each time.
* **The button vanished from the sidebar** after you right-clicked the Playlists tab to pop it out. The popped-out window and the sidebar now each have their own.
* **Add from Library showed the end of the results** when you searched after scrolling the list. Changing the search, tags or channels now brings the list back to the top, as the Library tab does.


# 0.0.6

### Added

* **Share soundboards with your players.** A new button on a board's toolbar shares it with the whole table. You can also give only some players **Observer** ownership of it in the Playlists sidebar. Players then get an Audio Console button of their own, which opens a window with the pads of every board shared with them. They can play and stop those pads, and do nothing else: no configuring, no editing, no library. Everyone hears what they fire, and you can stop it from the console like any other pad. The GM's Foundry tab has to be awake for their pads to play. If it is not, the player gets a notice within a few seconds instead of waiting with no answer.


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
