# Static preview coordinates

The original GLB is preserved without rewriting its mesh or scene data. Its catalogue declares `staticPreviewCoordinateSystem: "z-up"` so the runtime explicitly rotates its scene roots into canonical Y-up before display and AR conversion.

The prior gallery loaded static GLBs directly into its Z-up, millimetre viewer and applied `modelUnitScale: 1000`. This migration retains that physical scale by treating one original coordinate unit as one metre. See the pinned [static and fallback preview composition](https://github.com/ahzs645/tau/blob/996774cc25a147c085fbdcc47a4a89cc0dfe701f/apps/ui/app/routes/playground/playground-preview.tsx) and [model-viewer unit contract](https://github.com/ahzs645/tau/blob/996774cc25a147c085fbdcc47a4a89cc0dfe701f/apps/ui/app/components/model-viewer.tsx).
