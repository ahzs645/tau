/**
 * Centralized logging for KCL LSP components.
 *
 * Set `isDebugEnabled` to `true` to enable debug logging across all KCL LSP files.
 * This allows bulk enable/disable of logging for development and debugging.
 */

/** Master debug flag - set to true to enable logging across all KCL LSP components */
export const isDebugEnabled = false;

/**
 * Create a scoped logger for a specific component.
 *
 * @param component The component name (e.g., 'Hover Provider', 'LSP Client')
 * @returns A logging function that prefixes messages with the component name
 */
export function createLogger(component: string): (...arguments_: unknown[]) => void {
  return (...arguments_: unknown[]): void => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- debug flag can be toggled
    if (isDebugEnabled) {
      console.log(`[KCL ${component}]`, ...arguments_);
    }
  };
}

/**
 * Create a scoped warning logger for a specific component.
 * Warnings are always logged regardless of debug flag.
 *
 * @param component The component name
 * @returns A warning function that prefixes messages with the component name
 */
export function createWarningLogger(component: string): (...arguments_: unknown[]) => void {
  return (...arguments_: unknown[]): void => {
    console.warn(`[KCL ${component}]`, ...arguments_);
  };
}

/**
 * Create a scoped error logger for a specific component.
 * Errors are always logged regardless of debug flag.
 *
 * @param component The component name
 * @returns An error function that prefixes messages with the component name
 */
export function createErrorLogger(component: string): (...arguments_: unknown[]) => void {
  return (...arguments_: unknown[]): void => {
    console.error(`[KCL ${component}]`, ...arguments_);
  };
}
