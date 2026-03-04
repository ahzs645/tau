/* eslint-disable @typescript-eslint/naming-convention -- XState uses UPPER_CASE event types */
import { setup, assign } from 'xstate';
import type { ChatMode } from '@taucad/chat/constants';
import { chatMode } from '@taucad/chat/constants';

type ChatModeContext = {
  mode: ChatMode;
  activePlanPath: string | undefined;
};

type ChatModeEvent =
  | { type: 'SET_MODE'; mode: ChatMode }
  | { type: 'PLAN_FILE_DETECTED'; path: string }
  | { type: 'BUILD_APPROVED' }
  | { type: 'BUILD_COMPLETE' };

export const chatModeMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    context: {} as ChatModeContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    events: {} as ChatModeEvent,
  },
}).createMachine({
  id: 'chatMode',
  initial: 'idle',
  context: {
    mode: chatMode.agent,
    activePlanPath: undefined,
  },
  on: {
    SET_MODE: {
      actions: assign({
        mode: ({ event }) => event.mode,
      }),
    },
  },
  states: {
    idle: {
      on: {
        PLAN_FILE_DETECTED: {
          target: 'planCreated',
          actions: assign({
            activePlanPath: ({ event }) => event.path,
          }),
        },
      },
    },
    planCreated: {
      on: {
        BUILD_APPROVED: {
          target: 'building',
        },
        SET_MODE: {
          target: 'idle',
          actions: assign({
            mode: ({ event }) => event.mode,
            activePlanPath: undefined,
          }),
        },
      },
    },
    building: {
      on: {
        BUILD_COMPLETE: {
          target: 'idle',
          actions: assign({
            activePlanPath: undefined,
            mode: chatMode.agent,
          }),
        },
      },
    },
  },
});
