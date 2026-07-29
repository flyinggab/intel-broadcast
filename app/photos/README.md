# photos/

One subfolder per mission, e.g. `photos/roman-sead-joker1/`. Every file placed directly inside a
mission folder is sent as one batch when the GM presses the reveal hotkey while that mission is
active. Use a numeric filename prefix (`01-`, `02-`, …) to control browsing order in the viewer.

Only the GM's own machine needs this folder populated — pilots' viewer instances never read from
disk, they only display whatever arrives over the wire. Tracked in git by default like any other
repo asset; add mission-specific folders to the root `.gitignore` if a particular photo set
shouldn't be committed.
