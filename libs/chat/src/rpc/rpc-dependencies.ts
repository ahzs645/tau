/**
 * Abstract dependency interfaces for RPC handler execution.
 *
 * These interfaces decouple the RPC handler logic from its execution
 * environment, enabling the same handlers to run in:
 * - Browser (via fileManager, XState actors, WebGL)
 * - Node.js headless (via RuntimeFileSystem, runtime worker)
 * - Workers or other JS runtimes
 */
import type {
  CaptureObservationsRpcResult,
  CaptureScreenshotRpcResult,
  FetchGeometryRpcResult,
  GetKernelResultRpcResult,
  RpcClientErrorCode,
} from '#schemas/rpc.schema.js';

/**
 * Abstract filesystem for RPC handlers.
 * Implementations can wrap browser fileManager, RuntimeFileSystem (fromMemoryFS/fromNodeFS), etc.
 * @public
 */
export type RpcFileSystem = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  writeBinaryFile(path: string, data: Uint8Array<ArrayBuffer>): Promise<void>;
  deleteFile(path: string): Promise<void>;
  readdir(
    path: string,
  ): Promise<Array<{ name: string; type: 'file' | 'directory'; size: number; modifiedAt?: string }>>;
  exists(path: string): Promise<boolean>;
  appendFile(path: string, content: string): Promise<void>;
  editFile(path: string, oldString: string, newString: string, replaceAll?: boolean): Promise<{ occurrences: number }>;
  stat(path: string): Promise<RpcFileStat>;
};

/**
 * File metadata returned by stat().
 * @public
 */
export type RpcFileStat = {
  size: number;
  isDirectory: boolean;
  createdAt: string;
  modifiedAt: string;
};

/**
 * Abstract runtime client for getting compilation results.
 * Browser impl wraps projectRef (XState actor); headless impl wraps runtime worker directly.
 * @public
 */
export type RpcRuntimeClient = {
  getKernelResult(targetFile: string): Promise<GetKernelResultRpcResult>;
};

/**
 * Abstract graphics client for capturing observations (screenshots).
 * Only available in browser environments with a mounted 3D view.
 * @public
 */
export type RpcGraphicsClient = {
  captureObservations(): Promise<CaptureObservationsRpcResult>;
  fetchGeometry(): Promise<FetchGeometryRpcResult>;
  captureScreenshot(): Promise<CaptureScreenshotRpcResult>;
};

/**
 * Dependencies required by RPC handlers.
 * `graphics` is optional -- headless mode omits it, and handlers
 * return an error if a graphics operation is requested without it.
 * @public
 */
export type RpcDependencies = {
  fileSystem: RpcFileSystem;
  kernelClient: RpcRuntimeClient;
  graphics?: RpcGraphicsClient;
};

/**
 * Structured error returned by RPC handlers on failure.
 * @public
 */
export type RpcHandlerError = {
  success: false;
  errorCode: RpcClientErrorCode;
  message: string;
};
