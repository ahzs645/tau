import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { runVerificationProcess } from '#scripts/verification-process.js';

describe('native gallery verification deadline', () => {
  it('should terminate synchronous work even when the child event loop cannot run timers', async () => {
    const result = await runVerificationProcess({
      args: [
        '--eval',
        "process.send({type:'operation-start',operation:'render',scenario:'blocked-native-call'}); while (true) {}",
      ],
      cwd: process.cwd(),
      operationTimeout: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.operation).toBe('render');
    expect(result.scenario).toBe('blocked-native-call');
  });

  it('should preserve a worker failure instead of turning process completion into success', async () => {
    const result = await runVerificationProcess({
      args: ['--eval', 'process.exitCode = 7'],
      cwd: process.cwd(),
      operationTimeout: 5000,
    });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it('should enforce the whole-variant cap even when operations keep resetting their local deadline', async () => {
    const result = await runVerificationProcess({
      args: [
        '--eval',
        "setInterval(() => process.send({type:'operation-start',operation:'export',scenario:'repeated-operations'}), 25)",
      ],
      cwd: process.cwd(),
      operationTimeout: 5000,
      totalTimeout: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.operation).toBe('export');
  });
});
