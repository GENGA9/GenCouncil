# Study background reproduction

The current art was edited with Codex's built-in `image_gen`, using the existing
room plus foreground as the reference. `node run.mjs` prints the exact three
candidate prompts, selected candidate, wide prompt and registration constraints.
It deliberately does not invoke another AI CLI. Pillow is required for the scripts.

Keep source PNGs in an ignored directory (for this revision,
`.council/generated/`); do not commit full-size generation intermediates.
Prompts reproduce the procedure, not deterministic pixels. Exact pixel
reproduction requires retaining those source PNGs; RESULT.md records their hashes
and the built-in tool's original persistent output locations as well.

1. Composite the old `room.webp` and `desk.webp` at the old `deskTop`, over a
   flat green background. Save `reference-room.png`. Save the old room alpha as
   `window-alpha-original.png`. Keep all three outputs as `candidate-01.png` through
   `candidate-03.png`. Candidate 02 is used by the measured registration script.
2. Run `register.py <source-dir>` to produce the registered `room.png`, edit mask,
   window alpha and foreground props mask. It restores the original clock, glass
   frame, lamp and desk, and registers the enlarged laptop 115 pixels to the right.
3. For the wide generation reference, place a 0.6 copy of the registered room at
   `(307,120)` on the old 1536×1024 wide image. Generate with the recorded wide
   prompt and save `room-wide-generated.png`. Rerun `register.py <source-dir>`.
   It normalizes the outpaint to 2560×1707, restores the exact room using the
   inverse world transform, and feathers only outside its footprint.
4. Run `cut.py 756 825 --src <source-dir>` to save lossless WebP layers and update
   `study.json` with a new cache revision. Enlarged props raise the foreground
   crop top to 522; the actual desk line stays 756 and its front edge stays 825.

The existing window matte remains authoritative outside edited props. The new
laptop outline makes the covered glass opaque. Seasonal views are preserved by
default; `--views` is an explicit opt-in for a separate view regeneration.

The wide bitmap has a 2560×1707 raster and retains the measured world rectangle
`(-511.7,-200,2560,1706.7)`. The registration accounts for the slight vertical
raster/world difference. Room.tsx clock/lamp/floor anchors are unchanged.
