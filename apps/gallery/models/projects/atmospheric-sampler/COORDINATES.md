# Static preview coordinates

The original GLB is preserved without rewriting its mesh or scene data. Its catalogue declares `staticPreviewCoordinateSystem: "z-up"` so the runtime explicitly rotates its scene roots into canonical Y-up before display and AR conversion.

The prior gallery loaded static GLBs directly into its Z-up, millimetre viewer and applied `modelUnitScale: 1000`. This migration retains that physical scale by treating one original coordinate unit as one metre. See the pinned [static and fallback preview composition](https://github.com/ahzs645/tau/blob/996774cc25a147c085fbdcc47a4a89cc0dfe701f/apps/ui/app/routes/playground/playground-preview.tsx) and [model-viewer unit contract](https://github.com/ahzs645/tau/blob/996774cc25a147c085fbdcc47a4a89cc0dfe701f/apps/ui/app/components/model-viewer.tsx).

The Atmospheric Sampler asset contains large translations and scale factors, but no embedded physical-unit metadata. Its true manufactured size cannot be established from those values alone. This migration preserves the previous measurements; it does not guess a millimetre rescaling. Treat physical-size readouts and life-size AR for this inherited static model as unverified until an authored dimension or source CAD is supplied.
