import { setup, fromCallback, assign } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { FileExtension } from '@taucad/types';
import type { cadMachine } from '#machines/cad.machine.js';

// Context
type ExportGeometryContext = {
  cadRef: ActorRefFrom<typeof cadMachine> | undefined;
  activeRequest?: {
    format: FileExtension;
    options?: Record<string, unknown>;
    onSuccess: (blob: Blob, format: FileExtension) => void;
    onError: (error: string) => void;
  };
};

// Events
type ExportGeometryEvent =
  | {
      type: 'requestExport';
      format: FileExtension;
      options?: Record<string, unknown>;
      onSuccess: (blob: Blob, format: FileExtension) => void;
      onError: (error: string) => void;
    }
  | { type: 'exportCompleted'; blob: Blob; format: FileExtension }
  | { type: 'exportFailed'; error: string };

// Input
type ExportGeometryInput = {
  cadRef: ActorRefFrom<typeof cadMachine> | undefined;
};

// CAD listener actor - handles subscriptions to CAD machine events
const cadListener = fromCallback<ExportGeometryEvent, { cadRef: ActorRefFrom<typeof cadMachine> | undefined }>(
  ({ sendBack, input }) => {
    const { cadRef } = input;

    if (!cadRef) {
      return () => undefined;
    }

    // Subscribe to geometry export events
    const exportSubscription = cadRef.on('geometryExported', (event) => {
      sendBack({
        type: 'exportCompleted',
        blob: event.blob,
        format: event.format,
      });
    });

    // Subscribe to export failure events
    const errorSubscription = cadRef.on('exportFailed', (event) => {
      // Get first error message if available
      const firstError = event.errors[0];
      sendBack({
        type: 'exportFailed',
        error: firstError?.message ?? 'Export failed',
      });
    });

    // Cleanup function
    return () => {
      exportSubscription.unsubscribe();
      errorSubscription.unsubscribe();
    };
  },
);

export const exportGeometryMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate config
    context: {} as ExportGeometryContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate config
    events: {} as ExportGeometryEvent,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate config
    input: {} as ExportGeometryInput,
  },
  actors: {
    cadListener,
  },
  actions: {
    setActiveRequest: assign({
      activeRequest({ event }) {
        if (event.type !== 'requestExport') {
          return undefined;
        }

        return {
          format: event.format,
          options: event.options,
          onSuccess: event.onSuccess,
          onError: event.onError,
        };
      },
    }),
    clearActiveRequest: assign({
      activeRequest: undefined,
    }),
    sendExportRequest({ context }) {
      if (!context.activeRequest || !context.cadRef) {
        return;
      }

      context.cadRef.send({
        type: 'exportGeometry',
        format: context.activeRequest.format,
        options: context.activeRequest.options,
      });
    },
    handleExportSuccess({ context, event }) {
      if (event.type !== 'exportCompleted' || !context.activeRequest) {
        return;
      }

      try {
        context.activeRequest.onSuccess(event.blob, event.format);
      } catch (error) {
        console.error('Error in export success callback:', error);
      }
    },
    handleExportError({ context, event }) {
      if (event.type !== 'exportFailed' || !context.activeRequest) {
        return;
      }

      try {
        context.activeRequest.onError(event.error);
      } catch (error) {
        console.error('Error in export error callback:', error);
      }
    },
  },
}).createMachine({
  id: 'exportGeometry',
  context: ({ input }) => ({
    cadRef: input.cadRef,
    activeRequest: undefined,
  }),
  initial: 'idle',
  invoke: {
    id: 'cadListener',
    src: 'cadListener',
    input: ({ context }) => ({ cadRef: context.cadRef }),
  },
  states: {
    idle: {
      on: {
        requestExport: {
          target: 'exporting',
          actions: ['setActiveRequest', 'sendExportRequest'],
        },
      },
    },
    exporting: {
      on: {
        exportCompleted: {
          target: 'idle',
          actions: ['handleExportSuccess', 'clearActiveRequest'],
        },
        exportFailed: {
          target: 'idle',
          actions: ['handleExportError', 'clearActiveRequest'],
        },
        requestExport: {
          target: 'exporting',
          actions: ['setActiveRequest', 'sendExportRequest'],
          reenter: true,
        },
      },
    },
  },
});
