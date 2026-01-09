export const toolName = {
  webSearch: 'web_search',
  webBrowser: 'web_browser',
  imageAnalysis: 'analyze_image',
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
 * Client-side tools that use LangGraph interrupt() and are handled on the client.
 * These tools require the client to execute the action and return the result.
 * Server-only tools (transfers, web search) are NOT included here.
 */
export const clientToolNames = [
  toolName.imageAnalysis,
  toolName.readFile,
  toolName.editFile,
  toolName.listDirectory,
  toolName.createFile,
  toolName.deleteFile,
  toolName.grep,
  toolName.globSearch,
  toolName.getKernelResult,
] as const;

export type ClientToolName = (typeof clientToolNames)[number];

export const toolMode = {
  none: 'none',
  auto: 'auto',
  any: 'any',
  custom: 'custom',
} as const satisfies Record<string, string>;

export const toolModes = Object.values(toolMode) as [(typeof toolMode)[keyof typeof toolMode]];
