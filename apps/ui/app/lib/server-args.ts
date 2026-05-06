/** Value from `--host` / `--host=<addr>` (`undefined` means loopback-only, like Vite without `--host`). */
export type HostArgument = undefined | string;

/**
 * Mirrors Vite / `react-router dev` `--host` handling: `--host` alone binds every interface (`0.0.0.0`).
 *
 * @param argv - `process.argv`-shaped argument vector to scan.
 * @returns Resolved bind address, or `undefined` for loopback-only.
 */
export const parseHostArgument = (argv: readonly string[]): HostArgument => {
  for (let index = 0; index < argv.length; index++) {
    const cliArgument = argv[index]!;
    if (cliArgument === '--host') {
      const nextArgument = argv[index + 1];
      return nextArgument !== undefined && !nextArgument.startsWith('-') ? nextArgument : '0.0.0.0';
    }

    if (cliArgument.startsWith('--host=')) {
      const value = cliArgument.slice('--host='.length);
      return value === '' ? '0.0.0.0' : value;
    }
  }

  return undefined;
};

/**
 * `--https`, `--no-https`, and `--https=<truthy|falsey>` parity with usual CLI conventions.
 *
 * Bare `--https` behaves like `--https=true`. Later occurrences win (last-flag semantics).
 *
 * @param argv - `process.argv`-shaped argument vector to scan.
 * @returns `true` when HTTPS should be enabled, `false` otherwise.
 */
export const parseHttpsArgument = (argv: readonly string[]): boolean => {
  let lastResolved: undefined | boolean;

  for (const cliArgument of argv) {
    if (cliArgument === '--https') {
      lastResolved = true;
      continue;
    }

    if (cliArgument === '--no-https' || cliArgument === '--https=false') {
      lastResolved = false;
      continue;
    }

    if (cliArgument === '--https=true') {
      lastResolved = true;
      continue;
    }

    if (cliArgument.startsWith('--https=')) {
      const value = cliArgument.slice('--https='.length);
      lastResolved = !(value === '' || value === '0' || value === 'false');
    }
  }

  return lastResolved ?? false;
};
