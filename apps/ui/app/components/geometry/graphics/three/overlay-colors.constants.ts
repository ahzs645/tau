/**
 * Single tuning source for 3D viewport overlay tints (infinite grid + axes helper).
 *
 * Values are calibrated to render visibly across **both** WebGL (gamma-space canvas blend)
 * and WebGPU (linear-space framebuffer blend, sRGB-encoded at composite). A residual
 * ~10-15 sRGB/channel divergence is accepted as a known limitation: eliminating it would
 * require routing the overlay scene through a shared post-processing render target so the
 * canvas composite happens in the same color space on both backends. See the
 * `Color & Blending Parity` section in `docs/policy/graphics-backend-policy.md`.
 *
 * **Tuning rules** (do not break without policy review):
 * 1. Tune visually against `/e2e/graphics-backend` with both backends side-by-side.
 * 2. Never re-pin to a known-broken backend baseline (e.g. pre-`<colorspace_fragment>`
 *    WebGL output). Pinning to a bug freezes the bug into the design contract.
 * 3. Both backends must remain visibly above the threshold of perception in light AND
 *    dark mode — the prior `0xA6_A6_A6` light-mode value rendered nearly invisibly under
 *    WebGPU's linear blend.
 */

/**
 * Infinite grid line tint, **light theme**. sRGB hex.
 *
 * Light mode background is sRGB white (`#FFFFFF`). At alpha 0.3 over white:
 * - WebGL gamma blend → ~`#D5D5D5` perceptual.
 * - WebGPU linear blend → ~`#E2E2E2` perceptual.
 *
 * Both clearly visible; neither washes out.
 */
export const infiniteGridColorLightMode = 0x73_73_73;

/**
 * Infinite grid line tint, **dark theme**. sRGB hex.
 *
 * Dark mode background is sRGB `#171717`. At alpha 0.3 over the background:
 * - WebGL gamma blend → ~`#2A2A2A` perceptual.
 * - WebGPU linear blend → ~`#353535` perceptual.
 *
 * Both clearly visible against the dark surface without overwhelming geometry.
 */
export const infiniteGridColorDarkMode = 0x55_55_55;

/**
 * Default tints for the {@link AxesHelper} XYZ axis lines. Stock Three.js axis hues,
 * desaturated slightly so they read as orientation cues rather than primary geometry.
 * Consumed verbatim by `THREE.Color`; valid in any {@linkcode @react-three/drei} `<Line>`,
 * `Line2NodeMaterial`, or other Three.js color slot.
 */
export const axesHelperColors = {
  /* oxlint-disable tau-lint/no-hardcoded-color -- Three.js viewport axis tints */
  x: 'rgb(125, 56, 50)',
  y: 'rgb(64, 115, 63)',
  z: 'rgb(37, 78, 136)',
  /* oxlint-enable tau-lint/no-hardcoded-color */
} as const;

/**
 * Default opacity for {@link AxesHelper} axis lines.
 *
 * Both backends must honor this via `transparent: true` on the underlying material. The
 * drei `<Line>` WebGL path previously omitted the flag, causing `material.transparent` to
 * default to `false`; `THREE.WebGLRenderer` then skipped `gl.BLEND` and wrote the opaque
 * source color straight to the framebuffer, so opacity was silently dropped. WebGPU's
 * `Line2NodeMaterial` always set `transparent: true`, so it correctly blended at alpha 0.6
 * — and the dark axis tints muted into the background, reading as "darker" against the
 * full-saturation WebGL output. Setting `transparent: true` on the WebGL `<Line>` aligns
 * both backends on the same blended look.
 */
export const axesHelperOpacity = 0.6;
