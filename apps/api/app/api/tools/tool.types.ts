import type { ChatToolsService } from '#api/chat/chat-tools.service.js';
import type { FileEditService } from '#api/file-edit/file-edit.service.js';
import type { AnalysisService } from '#api/analysis/analysis.service.js';

/**
 * Configurable context passed to tools via LangChain RunnableConfig.
 * This allows tools to access services for executing tool operations.
 */
export type ChatToolsConfigurable = {
  /** The ChatToolsService instance for sending tool requests via WebSocket */
  chatToolsService: ChatToolsService;
  /** The FileEditService for processing file edits */
  fileEditService: FileEditService;
  /** The AnalysisService for processing image analysis */
  analysisService: AnalysisService;
  /** The chat/thread ID (LangGraph uses snake_case for thread_id) */
  thread_id: string;
};
