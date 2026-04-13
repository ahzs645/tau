import { z } from 'zod';

// ============================================================================
// Panel Constants
// ============================================================================

/**
 * Minimum panel size constants for the chat interface layout (in pixels)
 * Used for both default sizes and minimum constraints on panes
 */

/** Minimum width for standard side panels (Explorer, Parameters, Converter, Git, Details) */
export const panelMinSizeStandard = 200;

/** Minimum width for standard side panels (Explorer, Parameters, Converter, Git, Details) */
export const panelMinSizeChat = 240;

/** Minimum width for the Editor panel (code editing area) */
export const panelMinSizeEditor = 400;

/** Minimum width for the Viewer/center panel (main 3D CAD visualization area) */
export const panelMinSizeViewer = 416;

/** Mobile drawer snap points for the projects interface */
export const mobileDrawerSnapPoints: Array<number | string> = [0.7, 1];

/**
 * All panel identifiers - single source of truth for panel IDs.
 * Includes both toggleable panels and the always-visible viewer.
 */
export const panelIds = [
  'chat',
  'files',
  'explorer',
  'kernel',
  'viewer',
  'parameters',
  'editor',
  'converter',
  'git',
  'details',
] as const;

/**
 * Desktop panel identifiers - panels that can be opened/closed.
 * Excludes viewer which is always visible.
 */
export const desktopPanelIds = [
  'chat',
  'files',
  'explorer',
  'kernel',
  'parameters',
  'editor',
  'converter',
  'git',
  'details',
] as const;

/**
 * Panel order for Allotment layout - single source of truth for visual ordering.
 * This determines the left-to-right order of panels in the desktop interface.
 */
export const allotmentPanelOrder = [
  'chat',
  'files',
  'explorer',
  'kernel',
  'viewer',
  'parameters',
  'editor',
  'converter',
  'details',
] as const;

// ============================================================================
// Graphics View Settings
// ============================================================================

/**
 * Per-view graphics settings type.
 * These settings are stored per-build-per-view in EditorState and used to
 * initialize GraphicsMachine instances for each viewer panel.
 */
export type EnvironmentPreset = 'studio' | 'neutral' | 'soft' | 'performance';

/**
 * A measurement that the user has explicitly pinned for persistence.
 */
export type PinnedMeasurement = {
  id: string;
  startPoint: [number, number, number];
  endPoint: [number, number, number];
  distance: number;
  name?: string;
};

export type GraphicsViewSettings = {
  enableSurfaces: boolean;
  enableLines: boolean;
  enableGizmo: boolean;
  enableGrid: boolean;
  enableAxes: boolean;
  enableMatcap: boolean;
  enablePostProcessing: boolean;
  upDirection: 'x' | 'y' | 'z';
  cameraFovAngle: number;
  renderTimeout: number;
  environmentPreset: EnvironmentPreset;
  /** Persisted pinned measurements -- optional so legacy data deserializes cleanly */
  pinnedMeasurements?: PinnedMeasurement[];
};

// ============================================================================
// Zod Schemas for Runtime Validation of Persisted State
// ============================================================================

const vector3Schema = z.tuple([z.number(), z.number(), z.number()]);

const pinnedMeasurementSchema = z.object({
  id: z.string(),
  startPoint: vector3Schema,
  endPoint: vector3Schema,
  distance: z.number(),
  name: z.string().optional(),
});

export const graphicsViewSettingsSchema = z.object({
  enableSurfaces: z.boolean(),
  enableLines: z.boolean(),
  enableGizmo: z.boolean(),
  enableGrid: z.boolean(),
  enableAxes: z.boolean(),
  enableMatcap: z.boolean(),
  enablePostProcessing: z.boolean(),
  upDirection: z.enum(['x', 'y', 'z']),
  cameraFovAngle: z.number(),
  renderTimeout: z.number(),
  environmentPreset: z.enum(['studio', 'neutral', 'soft', 'performance']),
  pinnedMeasurements: z.array(pinnedMeasurementSchema).optional(),
});

/**
 * Safely parse persisted graphics view settings.
 * Returns validated settings on success, or defaults if the data is
 * missing / corrupt / from an older schema version.
 */
export function parseGraphicsViewSettings(raw: unknown): GraphicsViewSettings {
  const result = graphicsViewSettingsSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  return { ...defaultGraphicsSettings };
}

/**
 * Default graphics settings for new viewer panels.
 * Used when no persisted settings exist or when seeding a fresh layout.
 */
export const defaultGraphicsSettings: GraphicsViewSettings = {
  enableSurfaces: true,
  enableLines: true,
  enableGizmo: true,
  enableGrid: true,
  enableAxes: true,
  enableMatcap: false,
  enablePostProcessing: true,
  upDirection: 'z',
  cameraFovAngle: 60,
  renderTimeout: 30,
  environmentPreset: 'studio',
};

// ============================================================================
// Panel State Types (derived from constants above)
// ============================================================================

/** Type for all panel IDs (derived from panelIds constant) */
export type PanelId = (typeof panelIds)[number];

/** Type for desktop panel IDs (derived from desktopPanelIds constant) */
export type DesktopPanelId = (typeof desktopPanelIds)[number];

/**
 * Default panel state for new projects or when no stored state exists.
 */
export const defaultPanelState = {
  openPanels: {
    chat: true,
    files: false,
    explorer: false,
    kernel: false,
    parameters: true,
    editor: false,
    converter: false,
    git: false,
    details: false,
  },
  panelSizes: {
    chat: 300,
    files: 200,
    explorer: 300,
    kernel: 350,
    viewer: 420,
    parameters: 300,
    editor: 300,
    converter: 300,
    git: 300,
    details: 300,
  },
  mobileActiveTab: 'chat',
  kernelPaneview: {},
  parametersPaneview: {},
} as const satisfies {
  openPanels: Record<DesktopPanelId, boolean>;
  panelSizes: Record<PanelId, number>;
  mobileActiveTab: PanelId;
  kernelPaneview: Record<string, never>;
  parametersPaneview: Record<string, never>;
};
