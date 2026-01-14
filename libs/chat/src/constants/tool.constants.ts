export const toolName = {
  webSearch: 'web_search',
  webBrowser: 'web_browser',
  imageAnalysis: 'analyze_image',
  captureObservations: 'capture_observations',
  readFile: 'read_file',
  editFile: 'edit_file',
  listDirectory: 'list_directory',
  createFile: 'create_file',
  deleteFile: 'delete_file',
  grep: 'grep',
  globSearch: 'glob_search',
  getKernelResult: 'get_kernel_result',
  reasoning: 'reasoning',
  transferToCadExpert: 'transfer_to_cad_expert',
  transferToResearchExpert: 'transfer_to_research_expert',
  transferBackToSupervisor: 'transfer_back_to_supervisor',
} as const satisfies Record<string, string>;

export const toolNames = Object.values(toolName) as [(typeof toolName)[keyof typeof toolName]];

/**
 * Client-side tools that are executed on the frontend via WebSocket.
 * These tools require the client to execute the action and return the result.
 *
 * Note: edit_file and analyze_image are NOT included here because they are
 * orchestrated on the backend (they call these client tools internally).
 * Server-only tools (transfers, web search) are also NOT included here.
 */
export const clientToolNames = [
  toolName.captureObservations,
  toolName.readFile,
  toolName.listDirectory,
  toolName.createFile,
  toolName.deleteFile,
  toolName.grep,
  toolName.globSearch,
  toolName.getKernelResult,
] as const;

export const toolMode = {
  none: 'none',
  auto: 'auto',
  any: 'any',
  custom: 'custom',
} as const satisfies Record<string, string>;

export const toolModes = Object.values(toolMode) as [(typeof toolMode)[keyof typeof toolMode]];
