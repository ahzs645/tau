import { spawn } from 'node:child_process';
import process from 'node:process';

export type VerificationProcessResult = {
  readonly exitCode: number | undefined;
  readonly signal: NodeJS.Signals | undefined;
  readonly timedOut: boolean;
  readonly operation: string;
  readonly scenario: string;
};

/** Enforce deadlines outside the thread running synchronous native or WASM geometry. */
export const runVerificationProcess = async (input: {
  readonly args: readonly string[];
  readonly cwd: string;
  /** Milliseconds allowed for each native operation. */
  readonly operationTimeout: number;
  /** Optional millisecond cap for the entire child, including every operation and shutdown. */
  readonly totalTimeout?: number;
  readonly onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
}): Promise<VerificationProcessResult> => {
  const child = spawn(process.execPath, [...input.args], {
    cwd: input.cwd,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let timedOut = false;
  let operation = 'startup';
  let scenario = 'startup';
  let terminateTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    if (timedOut) {
      return;
    }
    timedOut = true;
    child.kill('SIGTERM');
    // A native extension may delay graceful shutdown; the OS still owns the deadline.
    terminateTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  };
  let deadline = setTimeout(terminate, input.operationTimeout);
  const totalDeadline = input.totalTimeout === undefined ? undefined : setTimeout(terminate, input.totalTimeout);
  const completion = Promise.withResolvers<VerificationProcessResult>();
  const cleanUp = (): void => {
    clearTimeout(deadline);
    clearTimeout(totalDeadline);
    clearTimeout(terminateTimer);
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (text: string) => input.onOutput?.('stdout', text));
  child.stderr?.on('data', (text: string) => input.onOutput?.('stderr', text));
  child.on('message', (message: unknown) => {
    if (
      timedOut ||
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      message.type !== 'operation-start' ||
      !('operation' in message) ||
      typeof message.operation !== 'string'
    ) {
      return;
    }
    operation = message.operation;
    scenario = 'scenario' in message && typeof message.scenario === 'string' ? message.scenario : scenario;
    clearTimeout(deadline);
    deadline = setTimeout(
      terminate,
      operation === 'dispose' ? Math.min(input.operationTimeout, 30_000) : input.operationTimeout,
    );
  });
  child.once('error', (error) => {
    cleanUp();
    completion.reject(error);
  });
  child.once('close', (exitCode, signal) => {
    cleanUp();
    completion.resolve({ exitCode: exitCode ?? undefined, signal: signal ?? undefined, timedOut, operation, scenario });
  });
  return completion.promise;
};
