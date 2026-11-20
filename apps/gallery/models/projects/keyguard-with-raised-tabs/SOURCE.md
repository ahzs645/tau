# Keyguard source and screenshot preview

The version 67 model is by Volksswitch and retains its original CC0 Public Domain Dedication in `main.scad`. The source, companion openings file and all ten preset definitions come from the [original gallery at commit 996774cc25a147c085fbdcc47a4a89cc0dfe701f](https://github.com/ahzs645/tau/tree/996774cc25a147c085fbdcc47a4a89cc0dfe701f/apps/ui/app/routes/playground/projects/keyguard-with-raised-tabs). The original `main.scad` Git blob is `41cce3ba9fd51a019b13f257672ee44b60a05d22`.

## Preview-only screenshot

The author's [screenshot comparison guide](https://volksswitch.org/index.php/volks-devices/customizable-3d-printable-keyguard-for-grid-based-free-form-and-hybrid-aac-apps-on-tablets/comparing-an-image-of-your-keyguard-to-a-screenshot-of-the-aac-app/) describes an image created from the user's own AAC app, converted to SVG and placed beside the model. It directs users to turn off the screenshot before the final render and STL export. The guide's current filename is `default.svg`; it explicitly identifies `screenshot.svg` as the older filename used by this version.

The inherited repository has no `screenshot.svg`. Four presets enable the screenshot: `New set 3`, `New set 4`, `Ipad 12.9 6thgen 4gridw`, and `Ipad 9th gen touch chat 15`. The original `show_screenshot` helper imports that absent file during final geometry generation, which the pinned native engine reports as an error even when it also emits a partial model.

The screenshot change adds only `if ($preview)` inside `show_screenshot`. Final geometry omits this preview decoration automatically, following the author's documented printing workflow. A normal OpenSCAD preview can still reach the same import when a user supplies their own screenshot. All preset values, the screenshot's path and transforms, valid printable geometry, and source license remain unchanged. No replacement screenshot is bundled, and missing inputs elsewhere still fail verification.

Native CSG comparisons for all four affected presets produce the same final geometry expression as the original source with `include_screenshot="no"`, after removing only empty `group()` nodes and presentation whitespace. A separate temporary synthetic-SVG fixture confirms that the helper imports an image with `$preview=true` and has no geometry with `$preview=false`; the fixture is not a project asset. These source-level comparisons establish source semantics; mesh precision and export integrity are verified separately through the runtime.

## Inherited contradictory frame preset

`New set 2` requests `generate="keyguard frame"` while setting `have_a_case="yes"` and `have_a_keyguard_frame="no"`. The original `keyguard_frame` module emits geometry only when both flags are `"yes"`. The exact original source and preset, run with the original pinned `openscad-wasm-prebuilt@1.2.0` engine, return status 1 and report `Current top level object is empty.` The migrated public session reproduced that failure. This preset sets `include_screenshot="no"`, so the screenshot change is unrelated.

The migration adds an assertion only to the non-laser `generate="keyguard frame"` branch. It explains the existing requirement before attempting to export an empty model:

> Keyguard frame output requires Have a case and Have a keyguard frame set to yes. Enable both, or choose keyguard output.

All saved preset bytes are retained. The regression matrix requires this exact diagnostic for `New set 2`; a different error or a successful render fails that check. A separate native integration control applies the unsaved override `have_a_keyguard_frame="yes"` to the same preset and requires a nonempty frame plus a dimensionally consistent STL, without inventing dimensions or altering any other value.

The preserved `presets.json` SHA-256 is `b16190beac9314e58753b3a740539c2dbd837a14cf32a1ec013af0afd0f868c7`. The original source SHA-256 is `c51be8e31ae5d7c5ce5d3f5a623e57b85906b68101320ed201273495dceb6332`; the JSON-serialized `New set 2` parameters have SHA-256 `73538d1e492131a97c311fbd9d0a8c5859a2679d6b3492b1c0995c3b67235c64`. The migration's ignored diagnostic reports retain both original and current failure evidence.

## Preserved tab-only preset

`New set 1` enables a case, disables the frame, and leaves both case-opening dimensions at zero. The original source derives a zero-size keyguard body from those opening dimensions; the preset's separate `keyguard_width=210` and `keyguard_height=160` values belong to the inactive frame branch. Its raised mounting tabs are generated independently, so the source still produces those tabs without a keyguard plate.

The migrated public session successfully renders and exports this exact preset: two mirrored tab owners, 264 triangles in total, with aggregate Z-up dimensions of approximately 13.8495 × 100 × 3.998 mm. This is a current native observation. Preservation follows from the byte-identical preset and the unchanged original dimension/tab branches; no separate original-engine render is claimed for this preset. Both source corrections are unreachable because it selects `generate="keyguard"` and `include_screenshot="no"`.

All saved values remain unchanged, and the matrix requires this preset to render and export successfully. Users who want a complete keyguard need to supply the actual case-opening dimensions. The migration does not invent those measurements or reject the existing tab-only output.
