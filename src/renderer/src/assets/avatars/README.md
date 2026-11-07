# Blinky avatar layers

`source/` contains the user's 13 original PNGs, unchanged (stable ASCII filenames).
`plates/` contains 13 eye-removal plates edited using the built-in image_gen tool.
The original files in Documents were never changed. `PROVENANCE.json` records the
prompt, processing method and SHA-256 values. `palette.json` and `SOURCE.md` are
the supplied palette and full usage specification.

`layers.json` is the reviewable native SVG geometry, in each original canvas's
pixel coordinates. Each shape has:

- `silhouette`: the largest opaque source component, traced with a small edge
  inset, to discard disconnected specks and the square/oval outer glow.
- `viewBox`: a square around that silhouette, with consistent padding. Source
  aspect ratio stays intact; ears and ornament remain visible.
- `face`: a hand-traced contour, refined along exposed source boundaries and
  smoothed. It excludes ears and ornament.
- `eyes`: independent original eye contours and their centers/radii, including
  the original highlights and material. These are the only moving layers.
- `luminance`: sampled source forehead luminance for palette normalization.

`BotAvatar.tsx` composes these layers. Only the removed-eye patches are taken
from the generated plate, so image generation cannot silently redesign the
rest of the character. Face tinting is a masked SVG luminance matrix, with
source-derived pink/dark feature protection. It is not a whole-image CSS filter
or a flat silhouette fill. A tiny soft boundary avoids a cut-paper seam.

Animated instances schedule independent blinks. Existing `run-started`,
`message-start`, `handoff`, `done` and `error` events drive the gaze, including
background home conversations. Message-end alone does not finish a run.
Reduced motion disables both blinking and gaze. Picker thumbnails are static.

Vite imports all PNGs as project assets. There are no Documents, home-directory,
generated-image-cache or network paths in the runtime renderer.

For acceptance evidence run `npm run build`, then
`node Scripts/test-avatar-electron.mjs`. This starts and stops only its own
Electron process, creates disposable fixture data and uses a fake local CLI.
It does not verify a real account, a real model or an installed Preview package.
