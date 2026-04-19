---
title: 'Dark Mode 3D Lighting Adaptation'
description: 'Investigation into theme-aware lighting for the CAD viewer to reduce surface brightness in dark mode while preserving color accuracy'
status: draft
created: '2026-04-08'
updated: '2026-04-08'
category: architecture
related:
  - docs/policy/ui-policy.md
---

# Dark Mode 3D Lighting Adaptation

Investigation into adapting the CAD viewer's Three.js lighting and rendering pipeline to respond to the active UI theme (`useTheme`), reducing surface brightness in dark mode to eliminate the jarring contrast between a dark chrome and bright 3D surfaces while preserving color accuracy.

## Executive Summary

The Tau viewer renders identically in light and dark mode — the only theme-aware elements are the CSS background, the grid color, and gizmo chrome. In dark mode the bright 3D surfaces create a "flashlight in a cave" effect. Professional CAD tools (Fusion 360, Blender, SolidWorks) separate UI theme from viewport environment, but web-native viewers can do better by coupling them smoothly. This document evaluates five adaptation strategies — exposure reduction, light intensity scaling, post-processing brightness/contrast, environment map modulation, and custom tone-mapping — ranking each by color accuracy, implementation cost, and visual quality. The recommended approach is a **multi-lever intensity attenuation** applied at the `applyLightingForCamera` call site, gated by the resolved theme, using the existing FOV compensation architecture as a template.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Current Architecture](#current-architecture)
- [Industry Survey](#industry-survey)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

When a user selects dark mode via `useTheme()` (resolves to `Theme.DARK`), the UI chrome transitions to dark backgrounds and muted surfaces. However, the WebGL canvas renders with the same lighting intensities as light mode:

- `environmentBaseIntensity = 0.9`
- `headlampBaseIntensity = 0.8`
- `ambientBaseIntensity = 0.05`
- `toneMappingExposure = 1`

The result is an extremely bright 3D viewport surrounded by a dark UI, causing:

1. **Visual discomfort** — the contrast ratio between chrome and 3D content exceeds comfortable bounds, especially on OLED displays.
2. **Perceived color inaccuracy** — the eye adapts to the dark surround, making already-bright surfaces appear washed-out or over-exposed.
3. **Inconsistency with professional tools** — CAD users expect a cohesive visual experience where dark mode reduces overall luminosity.

Only four elements currently respond to theme in the 3D layer:

| Element               | Theme adaptation                 |
| --------------------- | -------------------------------- |
| Canvas CSS background | `bg-background` (Tailwind token) |
| Grid color            | `lightgrey` → `grey`             |
| Gizmo label colors    | Hex swapped per theme            |
| Gizmo backgrounds     | Hex swapped per theme            |

The lighting rig, materials, tone mapping, environment maps, and post-processing are theme-agnostic.

## Methodology

1. **Codebase audit** — traced the full rendering pipeline from `ThreeProvider` → `Canvas` → `Stage` → `Lights` → `applyLightingForCamera`, cataloging every intensity constant, tone-mapping setting, and material path.
2. **Industry survey** — analyzed how Fusion 360, Blender, FreeCAD, Onshape, and the Autodesk Platform Services (Forge) Viewer handle dark/light mode in 3D viewports.
3. **Web research** — reviewed Three.js forum discussions, R3F dark mode tutorials, pmndrs/postprocessing documentation, and the Three.js tone mapping overview to identify proven techniques.
4. **Perceptual analysis** — evaluated each strategy against human color perception principles (Hunt effect, Stevens effect, surround-luminance adaptation).

## Current Architecture

### Lighting Pipeline

The lighting system is a camera-relative, FOV-compensated rig with four layers:

```
Canvas (toneMappingExposure=1, ACES filmic default)
  └─ Stage
       └─ Lights
            ├─ ambientLight          (intensity: 0.05)
            ├─ directionalLight      (headlamp, intensity: 0.8)
            ├─ Environment (drei)    (Lightformers, studio/neutral)
            │   └─ scene.environmentIntensity = 0.9 × fovCompensation
            ├─ hemisphereLight       (soft preset only)
            └─ directionalLights ×2  (performance preset only)
```

### Per-Frame Update (`applyLightingForCamera`)

Every frame, this function applies:

1. **FOV compensation** — at low FOV, dims environment (avoids specular wash) while boosting headlamp and ambient.
2. **Environment rotation** — swing-twist decomposition locks lightformers azimuthally to the camera.
3. **Headlamp positioning** — camera-space offset for consistent highlight bias.
4. **Ambient scaling** — compensates diffuse loss from environment dimming.

This per-frame function is the natural injection point for theme-based modulation because it already computes multiplicative factors from a `LightingConfig` object.

### Material Modes

| Mode          | Material type                      | Lighting response                         |
| ------------- | ---------------------------------- | ----------------------------------------- |
| PBR (default) | `MeshStandardMaterial` (from GLTF) | Full environment + headlamp + ambient     |
| Matcap        | `MeshMatcapMaterial`               | Ignores scene lights; uses matcap texture |
| Soft          | Hemisphere + ambient               | No environment map                        |
| Performance   | Hemisphere + 2 directionals        | No environment map                        |

Matcap mode is environment-independent — its brightness is baked into the matcap texture. Theme adaptation for matcap requires a separate approach (texture swap or tint).

### Post-Processing

N8AO ambient occlusion is the only post-processing effect. It darkens crevices but does not control overall brightness. The `EffectComposer` uses multisampling and stencil buffer but has no brightness/contrast pass.

### Theme Hook

`useTheme()` returns `{ theme: Theme.LIGHT | Theme.DARK, ... }`. The `Theme` enum comes from `remix-themes`. The resolved theme is always definite (never null at runtime). It is currently consumed by the Grid, gizmo components, and UI chrome.

## Industry Survey

### Finding 1: Professional CAD Tools Decouple UI Theme from Viewport Environment

| Tool             | UI dark mode              | Viewport lighting in dark mode                              | Approach                                      |
| ---------------- | ------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| **Fusion 360**   | Yes (2024+)               | Same 5 environment presets, independent of theme            | UI theme is purely chrome; viewport unchanged |
| **Blender**      | Default dark              | Material Preview has `Strength` slider for HDRI intensity   | User controls viewport brightness manually    |
| **Onshape**      | Yes                       | Viewport unchanged                                          | Chrome-only dark mode                         |
| **FreeCAD**      | Yes                       | Light intensity configurable via preferences                | Manual per-user setting                       |
| **Forge Viewer** | Yes (`viewer.setTheme()`) | `viewer.setTheme('dark-theme')` changes only toolbar/panels | Viewport rendering unchanged                  |

**Observation**: No major CAD tool automatically adjusts 3D viewport lighting when switching UI themes. They universally treat viewport rendering as an independent concern.

### Finding 2: Web 3D Viewers Are Beginning to Couple Theme and Viewport

Several Three.js community projects and tutorials demonstrate theme-responsive 3D scenes:

1. **YouTube tutorial** ("How to Add Dark Mode in R3F") — uses Valtio state to toggle lighting intensity and renderer clear color.
2. **Three.js forum** — fragment-shader `smoothstep` mixing of dark/light material colors based on screen coordinates.
3. **BrightnessContrast post-processing** — `@react-three/postprocessing` provides a `BrightnessContrast` effect with `-1..1` brightness range.

### Finding 3: Perceptual Science Supports Surround-Adapted Rendering

The Hunt effect and Stevens effect from color science describe how perceived color appearance changes with surround luminance:

- **Hunt effect**: Colorfulness (chroma) perception increases with luminance. In a dark surround, moderately saturated surfaces appear more vivid than intended.
- **Stevens effect**: Perceived contrast increases in dark surrounds. A surface that looks neutral in a light surround appears contrasty and harsh in a dark surround.

These effects mean that simply reducing brightness is insufficient for perceptual accuracy — a slight desaturation or contrast compression may also be needed to maintain perceived color fidelity.

## Findings

### Finding 2: Five Viable Adaptation Strategies

Each strategy is evaluated against four criteria:

| Criterion               | Description                                     |
| ----------------------- | ----------------------------------------------- |
| **Color accuracy**      | How well original material colors are preserved |
| **Implementation cost** | Lines of code, architectural impact, risk       |
| **Visual quality**      | Subjective appearance quality                   |
| **Matcap compat.**      | Whether it works with matcap mode               |

#### Strategy A: Tone Mapping Exposure Reduction

Reduce `gl.toneMappingExposure` from `1.0` to a dark-mode value (e.g., `0.7`).

| Criterion           | Rating   | Notes                                                                                                                                                       |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color accuracy      | Fair     | ACES filmic is non-linear — reducing exposure shifts hue response (oranges push toward yellow at lower exposure). Known ACES color banding issue amplified. |
| Implementation cost | Very low | Single line change in `onCreated` callback                                                                                                                  |
| Visual quality      | Moderate | Uniform darkening; no spatial selectivity. Shadows may become unreadably dark.                                                                              |
| Matcap compat.      | Yes      | Exposure is a renderer-global post-transform                                                                                                                |

**Risk**: Tone mapping exposure affects the entire render pass including post-processing. Background color (CSS-driven `bg-background`) is unaffected, creating a potential mismatch at the canvas boundary. ACES hue shift is well-documented — at lower exposure, saturated colors drift toward the 6 primary bands.

#### Strategy B: Light Intensity Scaling (Recommended)

Scale `environmentBaseIntensity`, `headlampBaseIntensity`, and `ambientBaseIntensity` by a theme-dependent factor (e.g., `0.7` in dark mode).

| Criterion           | Rating  | Notes                                                                                                                                                                             |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color accuracy      | Good    | Scaling illumination pre-shading preserves the PBR pipeline's linear-space math. Hue is preserved because the same light color at lower intensity produces the same chromaticity. |
| Implementation cost | Low     | Add theme factor to `LightingConfig`, multiply in `applyLightingForCamera`. Mirror the existing FOV compensation pattern.                                                         |
| Visual quality      | Good    | Preserves specular-to-diffuse ratio. Shadows remain readable because ambient floor is scaled proportionally.                                                                      |
| Matcap compat.      | Partial | Matcap ignores scene lights — requires separate matcap texture handling (tint overlay or darker texture).                                                                         |

**This is the recommended primary strategy.** It operates in the physically-correct space (pre-tone-mapping), leverages the existing `LightingConfig` infrastructure, and preserves the carefully tuned lighting rig's ratios.

#### Strategy C: Post-Processing Brightness/Contrast

Add a `BrightnessContrast` effect from `@react-three/postprocessing` to the existing `EffectComposer`.

| Criterion           | Rating   | Notes                                                                                                                                                                                         |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color accuracy      | Fair     | Brightness shift is a linear add in post-tone-mapped sRGB space. Darkening via negative brightness clips shadows. Slight contrast reduction (`-0.05`) can help counteract the Stevens effect. |
| Implementation cost | Low      | Add `<BrightnessContrast brightness={darkBrightness} contrast={darkContrast} />` to `PostProcessing`.                                                                                         |
| Visual quality      | Moderate | Operates post-tone-mapping, so darkening can introduce banding in shadows.                                                                                                                    |
| Matcap compat.      | Yes      | Post-processing is material-agnostic                                                                                                                                                          |

**Best used as a supplementary correction**, not primary. The BrightnessContrast effect can fine-tune perceived appearance after the primary lighting adjustment.

#### Strategy D: Environment Map Modulation

Reduce `scene.environmentIntensity` specifically in dark mode, leaving direct lights unchanged.

| Criterion           | Rating   | Notes                                                                                                                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Color accuracy      | Good     | Environment contribution is physically-based; reducing it dims reflections and indirect fill uniformly.                                                            |
| Implementation cost | Very low | Already computed per-frame in `applyLightingForCamera`.                                                                                                            |
| Visual quality      | Mixed    | Reduces specular reflections but leaves headlamp at full intensity — surfaces facing the camera stay bright. Creates an uneven dimming that may look inconsistent. |
| Matcap compat.      | No       | Matcap ignores environment maps entirely                                                                                                                           |

**Not recommended as standalone** — creates an imbalanced look. However, a slightly stronger environment reduction in dark mode (beyond the uniform scaling) can help tame specular hotspots.

#### Strategy E: Custom Tone Mapping / Color Grading

Switch to a more neutral tone mapper (AGX or Khronos PBR Neutral) in dark mode, or apply a LUT.

| Criterion           | Rating    | Notes                                                                                                                                                                |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color accuracy      | Excellent | Khronos PBR Neutral preserves hue better than ACES. AGX has excellent color preservation across intensity ranges.                                                    |
| Implementation cost | Medium    | Requires `renderer.toneMapping = THREE.AgXToneMapping` swap. May need to re-tune lighting intensities. LUT approach requires texture loading and custom shader pass. |
| Visual quality      | High      | Best perceptual result, especially for engineering colors (where hue accuracy matters).                                                                              |
| Matcap compat.      | Yes       | Tone mapping is renderer-global                                                                                                                                      |

**Viable as a future enhancement.** Switching tone mappers is a significant visual change that affects all users and should be evaluated independently. The Khronos PBR Neutral tone mapper (available in Three.js r162+) is the most promising for CAD use cases where material color accuracy is paramount.

### Finding 3: Matcap Mode Requires Special Treatment

Matcap materials are lit by a baked texture sphere, not by scene lights. The current matcap texture (`/textures/matcap-soft.png`) has fixed luminosity. Options for dark-mode matcap:

1. **Matcap tint** — multiply the matcap color by a dark-mode factor using `material.color.setScalar(factor)`. Cheapest approach, preserves shape perception.
2. **Dark matcap texture** — load a separate `/textures/matcap-soft-dark.png` with reduced brightness baked in. Best quality but requires maintaining a second texture asset.
3. **Post-processing** — Strategy C applies to matcap uniformly. Simplest but least control.

Recommendation: Use matcap tint (option 1) for the initial implementation, with texture swap as a future enhancement.

### Finding 4: Theme-Aware Intensity Should Not Be a Renderer Mutation

Mutating `gl.toneMappingExposure` or `renderer.toneMapping` requires careful lifecycle management because the R3F `Canvas` creates the renderer once. Theme changes that require renderer-level mutations need either:

- `useEffect` with `useThree()` to imperatively update the renderer.
- A `key` prop on `Canvas` to force remount (expensive, causes flicker).

The light intensity approach (Strategy B) avoids renderer mutations entirely — all changes are scene-graph properties updated per-frame, which is the established pattern.

### Finding 5: Perceptual Calibration Constants

Based on color science literature and CAD viewer conventions, recommended dark-mode adjustment ranges:

| Parameter                  | Light mode | Dark mode (recommended)    | Rationale                                                              |
| -------------------------- | ---------- | -------------------------- | ---------------------------------------------------------------------- |
| Overall intensity scale    | `1.0`      | `0.65–0.75`                | ~30% luminance reduction matches typical dark-mode surround adaptation |
| Environment intensity bias | `1.0×`     | `0.9×` of scaled value     | Slightly more aggressive env reduction tames specular hotspots         |
| Ambient floor boost        | `1.0×`     | `1.1–1.2×` of scaled value | Prevents shadows from going unreadably dark in the dim scene           |
| Post-processing brightness | `0`        | `-0.05 to -0.1`            | Fine-tune (optional supplementary)                                     |
| Post-processing contrast   | `0`        | `-0.03 to -0.05`           | Counteract Stevens effect (optional)                                   |
| Matcap tint                | `1.0`      | `0.7–0.8`                  | Match perceived brightness with PBR path                               |

These are starting points — final values require visual iteration with the actual Tau models in both themes.

## Recommendations

| #   | Action                                                                                                          | Priority | Effort | Impact                                                       |
| --- | --------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------ |
| R1  | Add `themeDarkIntensityScale` to `LightingConfig` and multiply all base intensities in `applyLightingForCamera` | P0       | Low    | High — eliminates bright surfaces in dark mode               |
| R2  | Thread `theme` from `useTheme()` through `Lights` → `applyLightingForCamera` via props/config                   | P0       | Low    | Required for R1                                              |
| R3  | Add a slight ambient floor boost in dark mode to prevent crushed shadows                                        | P0       | Low    | Medium — maintains shadow readability                        |
| R4  | Apply matcap tint (`material.color.setScalar`) for dark-mode matcap users                                       | P1       | Low    | Medium — covers matcap rendering path                        |
| R5  | Add optional `BrightnessContrast` post-processing pass for fine-tuning                                          | P2       | Low    | Low-Medium — supplementary perceptual correction             |
| R6  | Evaluate Khronos PBR Neutral tone mapping as the default for both themes                                        | P3       | Medium | High — better color accuracy for CAD, but requires re-tuning |
| R7  | Investigate dark matcap texture asset for optimal matcap dark-mode quality                                      | P3       | Low    | Low — refinement only                                        |

## Trade-offs

### Uniform Scaling vs Per-Light-Type Scaling

| Approach                                                                | Pros                                                                       | Cons                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| **Uniform scale** (single multiplier for all lights)                    | Simple, predictable, preserves lighting ratios exactly                     | May leave specular too bright or shadows too dark |
| **Per-light-type scale** (different factors for env, headlamp, ambient) | Fine-grained control, can independently tame specular and preserve shadows | More constants to tune, harder to reason about    |

Recommendation: Start with a uniform scale (R1) and add per-light-type bias (env reduction, ambient boost) as documented in Finding 5. The existing FOV compensation system already demonstrates the per-light-type approach, so the pattern is established.

### Continuous Transition vs Binary Switch

| Approach                                             | Pros                                 | Cons                                                              |
| ---------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| **Binary switch** (full light vs dark intensity)     | Simple, matches CSS theme transition | Abrupt visual change when toggling theme                          |
| **Animated transition** (lerp intensity over ~300ms) | Smooth, pleasant UX                  | Requires per-frame interpolation state; must handle rapid toggles |

Recommendation: Start with a binary switch. The CSS theme transition already uses `transition-colors` for chrome elements — the 3D viewport can follow the same instant-switch pattern. Animated transitions can be added later if user feedback indicates desire for smooth blending.

### Where to Inject Theme Awareness

| Location                                                           | Pros                                                    | Cons                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------- |
| **`Lights` component** (pass theme as prop)                        | Clean, declarative; theme flows through React props     | Requires prop-drilling or context from `useTheme`             |
| **`applyLightingForCamera`** (add theme field to `LightingConfig`) | Single source of truth; screenshot system also benefits | Config object grows; need to pass theme to screenshot capture |
| **`ThreeProvider`** (modify `onCreated`)                           | Centralised renderer control                            | Only works for exposure-based approach                        |

Recommendation: Inject at the `Lights` component level — call `useTheme()` inside `Lights`, compute the dark-mode multiplier, and pass it through the existing `config` object to `applyLightingForCamera`. This keeps the pure utility function theme-agnostic (it just receives numeric factors) while the React component handles the theme resolution.

## Code Examples

### R1+R2: Theme-Aware Intensity in Lights Component

```typescript
// In lights.utils.ts — add theme scale type to config
export type LightingConfig = {
  sceneRadius: number;
  upDirection: 'x' | 'y' | 'z';
  headlampIntensity: number;
  ambientIntensity: number;
  environmentIntensity: number;
  headlampConfig: HeadlampConfig;
  /** Theme-based overall intensity scale (1.0 for light, ~0.7 for dark) */
  themeIntensityScale?: number;
  /** Theme-based ambient floor boost (1.0 for light, ~1.15 for dark) */
  themeAmbientBoost?: number;
};
```

```typescript
// In applyLightingForCamera — apply theme scaling after FOV compensation
const themeScale = config.themeIntensityScale ?? 1;
const themeAmbientBoost = config.themeAmbientBoost ?? 1;

scene.environmentIntensity = config.environmentIntensity * compensation.envFactor * themeScale;

if (ambient) {
  ambient.intensity = config.ambientIntensity * compensation.ambientFactor * themeScale * themeAmbientBoost;
}

if (headlamp) {
  headlamp.intensity = config.headlampIntensity * compensation.headlampFactor * themeScale;
  // ... positioning unchanged
}
```

```typescript
// In Lights component — resolve theme and compute scale
import { Theme, useTheme } from '#hooks/use-theme.js';

const darkModeIntensityScale = 0.7;
const darkModeAmbientBoost = 1.15;

export function Lights({ ... }: LightsProperties) {
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;

  // ... existing code ...

  useFrame(() => {
    applyLightingForCamera({
      scene,
      camera,
      headlamp: cameraLightReference.current ?? undefined,
      ambient: ambientReference.current ?? undefined,
      config: {
        sceneRadius: radiusRef.current,
        upDirection,
        headlampIntensity: headlampBaseIntensity,
        ambientIntensity: ambientBaseIntensity,
        environmentIntensity: environmentBaseIntensity,
        headlampConfig: defaultHeadlampConfig,
        themeIntensityScale: isDark ? darkModeIntensityScale : 1,
        themeAmbientBoost: isDark ? darkModeAmbientBoost : 1,
      },
    });
  });
}
```

### R4: Matcap Dark-Mode Tint

```typescript
// In gltf-matcap.ts — add theme tint parameter
export const applyMatcap = async (gltf: GLTF, darkModeTint?: number): Promise<void> => {
  const matcapTexture = matcapMaterial();
  const tint = darkModeTint ?? 1;

  gltf.scene.traverse((child) => {
    if (child instanceof LineSegments2) return;
    if ('isMesh' in child && child.isMesh) {
      const meshMatcap = new MeshMatcapMaterial({
        matcap: matcapTexture,
        side: DoubleSide,
      });
      // ... existing vertex color / material color logic ...

      // Apply dark mode tint
      if (tint < 1) {
        meshMatcap.color.multiplyScalar(tint);
      }

      mesh.material = meshMatcap;
    }
  });
};
```

### R5: Optional Post-Processing Fine-Tuning

```typescript
// In post-processing.tsx — add BrightnessContrast for dark mode
import { BrightnessContrast } from '@react-three/postprocessing';
import { Theme, useTheme } from '#hooks/use-theme.js';

export function PostProcessing() {
  const enablePostProcessing = useGraphicsSelector((state) => state.context.enablePostProcessing);
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;

  if (!enablePostProcessing) return undefined;

  return (
    <EffectComposer stencilBuffer multisampling={4}>
      <N8AO screenSpaceRadius aoRadius={24} intensity={1} distanceFalloff={0} />
      {isDark ? <BrightnessContrast brightness={-0.05} contrast={-0.03} /> : null}
    </EffectComposer>
  );
}
```

## Diagrams

### Light Intensity Flow with Theme Modulation

```
┌──────────────┐     ┌──────────────┐     ┌─────────────────┐
│  useTheme()  │────▶│   Lights     │────▶│ applyLighting   │
│  DARK/LIGHT  │     │  component   │     │ ForCamera()     │
└──────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                     ┌─────────────────────────────┼─────────────────────────────┐
                     │           Per-frame          │                             │
                     ▼                              ▼                            ▼
              ┌──────────────┐           ┌──────────────────┐         ┌──────────────┐
              │ environment  │           │    headlamp      │         │   ambient    │
              │ Intensity    │           │    intensity     │         │   intensity  │
              │              │           │                  │         │              │
              │ base × fov   │           │ base × fov      │         │ base × fov   │
              │   × theme    │           │   × theme       │         │   × theme    │
              │   [× envBias]│           │                  │         │   × ambBoost │
              └──────────────┘           └──────────────────┘         └──────────────┘

Legend:
  fov      = FOV compensation factor (existing)
  theme    = themeIntensityScale (new: 1.0 light / 0.7 dark)
  envBias  = optional dark-mode env reduction (0.9×)
  ambBoost = dark-mode ambient floor boost (1.15×)
```

### Screenshot System Compatibility

The screenshot capture system reads `scene.userData[lightingUserDataKeys.config]` and calls `applyLightingForCamera` with the stored config. Theme scaling must be persisted on `scene.userData` alongside the existing `SceneLightingConfig` so screenshots reflect the user's current theme.

## References

- [Three.js Tone Mapping Overview](https://discourse.threejs.org/t/tone-mapping-overview/75204) — comprehensive comparison of ACES, AGX, Reinhard, Khronos PBR Neutral tone mappers
- [Three.js Dark & Light Mode Forum Thread](https://discourse.threejs.org/t/dark-and-light-mode/38730) — shader-level dark/light mixing approach
- [Autodesk Forge Viewer Dark Mode](https://aps.autodesk.com/blog/dark-light-mode-viewer) — `viewer.setTheme()` API (chrome only, viewport unchanged)
- [Fusion 360 Dark Mode](https://www.autodesk.com/products/fusion-360/blog/a-fresh-look-for-fusion-dark-and-light-mode-are-now-here/) — UI theme decoupled from 5 viewport environment presets
- [Blender Viewport Shading Manual](https://docs.blender.org/manual/en/latest/editors/3dview/display/shading.html) — Material Preview strength slider for HDRI intensity
- [pmndrs BrightnessContrast](https://react-postprocessing.docs.pmnd.rs/effects/brightness-contrast) — post-processing brightness/contrast effect
- [R3F Dark Mode Tutorial (YouTube)](https://www.youtube.com/watch?v=pgJ-HjvftE0) — Valtio-based dark mode toggle for R3F scenes
- [Hunt Effect](https://en.wikipedia.org/wiki/Hunt_effect) — colorfulness perception increases with luminance
- [Stevens Effect](https://en.wikipedia.org/wiki/Stevens%27_power_law) — perceived contrast increases in dark surrounds
- Related: `apps/ui/app/hooks/use-theme.tsx` — theme resolution hook
- Related: `apps/ui/app/components/geometry/graphics/three/utils/lights.utils.ts` — lighting constants and per-frame update
- Related: `apps/ui/app/components/geometry/graphics/three/react/lights.tsx` — Lights component
- Related: `apps/ui/app/components/geometry/graphics/three/post-processing.tsx` — N8AO post-processing
