import type { InspectionEvent } from 'xstate';

// Toggle this to enable/disable inspector
const inspectEnabled = false;

// Default to console inspector for easy debugging
const isConsoleInspectorEnabled = true;

export function consoleInspector(args: InspectionEvent): void {
  if (args.type === '@xstate.event') {
    console.info('XState Event:', args.event);
  }
}

const getBrowserInspector = async () => {
  const m = await import('@statelyai/inspect');
  return m.createBrowserInspector({ url: 'https://stately.ai/registry/inspect?rightPanel=sequence' }).inspect;
};

// oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- enables easy debugging
export const inspect = inspectEnabled
  ? // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- enables easy debugging
    isConsoleInspectorEnabled
    ? consoleInspector
    : await getBrowserInspector()
  : undefined;
