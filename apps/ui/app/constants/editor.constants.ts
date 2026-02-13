// ============================================================================
// Panel Constants
// ============================================================================

/**
 * Minimum panel size constants for the chat interface layout (in pixels)
 * Used for both default sizes and minimum constraints on panes
 */

/** Minimum width for standard side panels (Chat History, Explorer, Parameters, Converter, Git, Details) */
export const panelMinSizeStandard = 200;

/** Minimum width for the Editor panel (code editing area) */
export const panelMinSizeEditor = 400;

/** Minimum width for the Viewer/center panel (main 3D CAD visualization area) */
export const panelMinSizeViewer = 416;

/** Mobile drawer snap points for the builds interface */
export const mobileDrawerSnapPoints: Array<number | string> = [0.7, 1];

/**
 * All panel identifiers - single source of truth for panel IDs.
 * Includes both toggleable panels and the always-visible viewer.
 */
export const panelIds = [
  'chat',
  'files',
  'explorer',
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
export type GraphicsViewSettings = {
  enableSurfaces: boolean;
  enableLines: boolean;
  enableGizmo: boolean;
  enableGrid: boolean;
  enableAxes: boolean;
  enableMatcap: boolean;
  upDirection: 'x' | 'y' | 'z';
  cameraFovAngle: number;
  renderTimeout: number;
};

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
  upDirection: 'z',
  cameraFovAngle: 60,
  renderTimeout: 60,
};

// ============================================================================
// Panel State Types (derived from constants above)
// ============================================================================

/** Type for all panel IDs (derived from panelIds constant) */
export type PanelId = (typeof panelIds)[number];

/** Type for desktop panel IDs (derived from desktopPanelIds constant) */
export type DesktopPanelId = (typeof desktopPanelIds)[number];

/**
 * Default panel state for new builds or when no stored state exists.
 */
export const defaultPanelState = {
  openPanels: {
    chat: true,
    files: false,
    explorer: false,
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
    viewer: 420,
    parameters: 300,
    editor: 300,
    converter: 300,
    git: 300,
    details: 300,
  },
  mobileActiveTab: 'chat',
} as const satisfies {
  openPanels: Record<DesktopPanelId, boolean>;
  panelSizes: Record<PanelId, number>;
  mobileActiveTab: PanelId;
};
