# Keyguard source and screenshot preview

The version 67 model is by Volksswitch and retains its original CC0 Public Domain Dedication in `main.scad`. The source, companion openings file and all ten preset definitions come from the [original gallery at commit 996774cc25a147c085fbdcc47a4a89cc0dfe701f](https://github.com/ahzs645/tau/tree/996774cc25a147c085fbdcc47a4a89cc0dfe701f/apps/ui/app/routes/playground/projects/keyguard-with-raised-tabs). The original `main.scad` Git blob is `41cce3ba9fd51a019b13f257672ee44b60a05d22`.

## Preview-only screenshot

The author's [screenshot comparison guide](https://volksswitch.org/index.php/volks-devices/customizable-3d-printable-keyguard-for-grid-based-free-form-and-hybrid-aac-apps-on-tablets/comparing-an-image-of-your-keyguard-to-a-screenshot-of-the-aac-app/) describes an image created from the user's own AAC app, converted to SVG and placed beside the model. It directs users to turn off the screenshot before the final render and STL export. The guide's current filename is `default.svg`; it explicitly identifies `screenshot.svg` as the older filename used by this version.

The inherited repository has no `screenshot.svg`. Four presets enable the screenshot: `New set 3`, `New set 4`, `Ipad 12.9 6thgen 4gridw`, and `Ipad 9th gen touch chat 15`. The original `show_screenshot` helper imports that absent file during final geometry generation, which the pinned native engine reports as an error even when it also emits a partial model.

The migration adds only `if ($preview)` inside `show_screenshot`. Final geometry omits this preview decoration automatically, following the author's documented printing workflow. A normal OpenSCAD preview can still reach the same import when a user supplies their own screenshot. All preset values, the screenshot's path and transforms, printable model code, and source license remain unchanged. No replacement screenshot is bundled, and missing inputs elsewhere still fail verification.

Native CSG comparisons for all four affected presets produce the same final geometry expression as the original source with `include_screenshot="no"`, after removing only empty `group()` nodes and presentation whitespace. A separate temporary synthetic-SVG fixture confirms that the helper imports an image with `$preview=true` and has no geometry with `$preview=false`; the fixture is not a project asset. These source-level comparisons do not certify mesh topology: the inherited native OFF output has precision-collapsed faces that remain a separate runtime/export concern.
