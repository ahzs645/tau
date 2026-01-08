import { setup, fromPromise, assign } from 'xstate';
import type { DoneActorEvent } from 'xstate';
import type {
  Observation,
  ObservationResult,
  RequirementResult,
  EvaluationCriteria,
  ImageAnalysisOutput,
} from '@taucad/chat';
import { ENV } from '#environment.config.js';

/**
 * Response from the analyze-observations API endpoint
 */
type AnalyzeObservationsResponse = {
  observationResults: ObservationResult[];
  aggregatedResults: RequirementResult[];
  evaluationCriteria: EvaluationCriteria;
};

/**
 * Context type for the image analysis machine
 */
type ImageAnalysisContext = {
  observations: Observation[];
  requirements: string[];
  observationResults: ObservationResult[];
  aggregatedResults: RequirementResult[];
  evaluationCriteria?: EvaluationCriteria;
  error?: string;
};

/**
 * Input type for the machine
 */
type ImageAnalysisMachineInput = {
  observations: Observation[];
  requirements: string[];
};

/**
 * Actor input for the API call
 */
type AnalyzeObservationsInput = {
  observations: Observation[];
  requirements: string[];
};

/**
 * Internal events
 */
type ImageAnalysisEventInternal =
  | { type: 'analyze'; observations: Observation[]; requirements: string[] }
  | { type: 'reset' };

/**
 * Actor names for type safety
 */
const imageAnalysisActors = {
  analyzeObservationsActor: 'analyzeObservationsActor',
} as const;
type ImageAnalysisActorNames = keyof typeof imageAnalysisActors;

/**
 * Done event type
 */
type ImageAnalysisEventDone = DoneActorEvent<AnalyzeObservationsResponse, ImageAnalysisActorNames>;

type ImageAnalysisEvent = ImageAnalysisEventInternal | ImageAnalysisEventDone;

/**
 * Actor that calls the analyze-observations API endpoint
 */
const analyzeObservationsActor = fromPromise<AnalyzeObservationsResponse, AnalyzeObservationsInput>(
  async ({ input, signal }) => {
    const requestBody = {
      observations: input.observations,
      requirements: input.requirements,
    };

    const response = await fetch(`${ENV.TAU_API_URL}/v1/analysis/observations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[analyzeObservationsActor] Error response:', errorText);
      throw new Error(`Analysis failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = (await response.json()) as AnalyzeObservationsResponse;

    return result;
  },
);

/**
 * Image Analysis Machine
 *
 * Sends observations to the API for parallel analysis and aggregation.
 * The API handles all the heavy lifting - this machine just manages the request lifecycle.
 *
 * States:
 * - idle: Waiting for analyze event
 * - analyzing: Waiting for API response
 * - success: Analysis complete with results
 * - error: Analysis failed
 */
export const imageAnalysisMachine = setup({
  types: {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate config
    context: {} as ImageAnalysisContext,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate config
    events: {} as ImageAnalysisEvent,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate config
    input: {} as ImageAnalysisMachineInput,
  },
  actors: {
    analyzeObservationsActor,
  },
  actions: {
    setResults: assign(({ event }) => {
      const doneEvent = event as ImageAnalysisEventDone;
      return {
        observationResults: doneEvent.output.observationResults,
        aggregatedResults: doneEvent.output.aggregatedResults,
        evaluationCriteria: doneEvent.output.evaluationCriteria,
      };
    }),
    setError: assign({
      error({ event }) {
        if ('error' in event && event.error instanceof Error) {
          return event.error.message;
        }

        return 'Unknown error occurred';
      },
    }),
    clearError: assign({
      error: undefined,
    }),
    reset: assign({
      observations: [],
      requirements: [],
      observationResults: [],
      aggregatedResults: [],
      evaluationCriteria: undefined,
      error: undefined,
    }),
  },
}).createMachine({
  id: 'imageAnalysis',
  context: ({ input }) => ({
    observations: input.observations,
    requirements: input.requirements,
    observationResults: [],
    aggregatedResults: [],
    evaluationCriteria: undefined,
    error: undefined,
  }),
  initial: 'analyzing',
  states: {
    idle: {
      on: {
        analyze: {
          target: 'analyzing',
          actions: assign({
            observations: ({ event }) => event.observations,
            requirements: ({ event }) => event.requirements,
            observationResults: [],
            aggregatedResults: [],
            evaluationCriteria: undefined,
            error: undefined,
          }),
        },
      },
    },
    analyzing: {
      invoke: {
        id: 'analyzeObservationsActor',
        src: 'analyzeObservationsActor',
        input: ({ context }) => ({
          observations: context.observations,
          requirements: context.requirements,
        }),
        onDone: {
          target: 'success',
          actions: 'setResults',
        },
        onError: {
          target: 'error',
          actions: 'setError',
        },
      },
    },
    success: {
      on: {
        analyze: {
          target: 'analyzing',
          actions: assign({
            observations: ({ event }) => event.observations,
            requirements: ({ event }) => event.requirements,
            observationResults: [],
            aggregatedResults: [],
            evaluationCriteria: undefined,
            error: undefined,
          }),
        },
        reset: {
          target: 'idle',
          actions: 'reset',
        },
      },
    },
    error: {
      on: {
        analyze: {
          target: 'analyzing',
          actions: [
            'clearError',
            assign({
              observations: ({ event }) => event.observations,
              requirements: ({ event }) => event.requirements,
              observationResults: [],
              aggregatedResults: [],
              evaluationCriteria: undefined,
            }),
          ],
        },
        reset: {
          target: 'idle',
          actions: 'reset',
        },
      },
    },
  },
});

export type ImageAnalysisMachineActor = typeof imageAnalysisMachine;

/**
 * Helper to build ImageAnalysisOutput from machine context
 */
export function buildImageAnalysisOutput(context: ImageAnalysisContext): ImageAnalysisOutput {
  return {
    observations: context.observations,
    observationResults: context.observationResults,
    aggregatedResults: context.aggregatedResults,
    evaluationCriteria: context.evaluationCriteria ?? {
      totalObservations: 0,
    },
  };
}
