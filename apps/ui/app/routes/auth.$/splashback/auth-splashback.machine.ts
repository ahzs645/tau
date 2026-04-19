import { setup } from 'xstate';

type AuthSplashbackContext = {
  error: Error | undefined;
};

type AuthSplashbackEvent =
  | { type: 'typingComplete' }
  | { type: 'enterComplete' }
  | { type: 'userInteraction' }
  | { type: 'morphComplete' } // Point cloud morph animation finished (gear12 -> gear8)
  | { type: 'morph2Complete' } // Point cloud morph animation finished (gear8 -> assembly)
  | { type: 'geometriesReady' } // Both source and target geometries are ready for morphing
  | { type: 'gear8MeshReady' } // Gear8 mesh is loaded and ready for crossfade
  | { type: 'assemblyMeshReady' }; // Assembly meshes are loaded and ready after crossfade

export const timing = {
  loadingDuration: 1200,
  gear12AnimateInDuration: 500,
  displayDuration: 3000,
  morphDuration: 1400, // Duration for point cloud morph animation
  crossfadeDuration: 400, // Duration for crossfade from point cloud to mesh
  gear8AnimateInDuration: 400,
  gear8DisplayDuration: 3000,
  assemblyAnimateInDuration: 400,
  assemblyDisplayDuration: 6000,
  fadeDuration: 800,
  resetDelay: 1000,
};

export const authSplashbackMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as AuthSplashbackContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as AuthSplashbackEvent,
  },
}).createMachine({
  id: 'authSplashback',
  initial: 'prompt1',
  context: { error: undefined },
  states: {
    prompt1: {
      initial: 'typing',
      states: {
        typing: {
          on: { typingComplete: 'enterKey' },
        },
        enterKey: {
          on: { enterComplete: '#authSplashback.loading' },
        },
      },
    },
    loading: {
      after: {
        [timing.loadingDuration]: 'gear12',
      },
    },
    gear12: {
      initial: 'animatingIn',
      states: {
        animatingIn: {
          after: {
            [timing.gear12AnimateInDuration]: 'displaying',
          },
        },
        displaying: {
          after: {
            [timing.displayDuration]: 'prompt2',
          },
          on: {
            // Re-enter to reset the timer when user interacts
            userInteraction: { target: 'displaying', reenter: true },
          },
        },
        prompt2: {
          initial: 'typing',
          states: {
            typing: {
              on: { typingComplete: 'enterKey' },
            },
            enterKey: {
              // Use morph transition instead of scale-based shrinking
              on: { enterComplete: '#authSplashback.preparingMorph' },
            },
          },
        },
      },
    },
    // Point cloud morph transition: gear12 -> gear8
    // Waits for both geometries to be ready, then runs morph animation
    preparingMorph: {
      on: {
        geometriesReady: 'morphingToGear8',
      },
    },
    morphingToGear8: {
      on: {
        morphComplete: 'gear8WaitingForMesh',
      },
      // Fallback timeout in case morph complete event is missed
      after: {
        [timing.morphDuration + 500]: 'gear8WaitingForMesh',
      },
    },
    // Intermediate state: morph complete, waiting for gear8 mesh to be ready
    // Point cloud stays visible until mesh is loaded and crossfade begins
    gear8WaitingForMesh: {
      on: {
        gear8MeshReady: 'gear8',
      },
      // Fallback timeout in case mesh ready event is missed
      after: {
        [timing.crossfadeDuration + 500]: 'gear8',
      },
    },
    gear8: {
      initial: 'animatingIn',
      states: {
        animatingIn: {
          after: {
            [timing.gear8AnimateInDuration]: 'displaying',
          },
        },
        displaying: {
          after: {
            [timing.gear8DisplayDuration]: 'prompt3',
          },
          on: {
            // Re-enter to reset the timer when user interacts
            userInteraction: { target: 'displaying', reenter: true },
          },
        },
        prompt3: {
          initial: 'typing',
          states: {
            typing: {
              on: { typingComplete: 'enterKey' },
            },
            enterKey: {
              // Use morph transition instead of scale-based shrinking
              on: { enterComplete: '#authSplashback.preparingMorph2' },
            },
          },
        },
      },
    },
    // Point cloud morph transition: gear8 -> assembly
    preparingMorph2: {
      on: {
        geometriesReady: 'morphingToAssembly',
      },
    },
    morphingToAssembly: {
      on: {
        morph2Complete: 'assemblyWaitingForMesh',
      },
      // Fallback timeout in case morph complete event is missed
      after: {
        [timing.morphDuration + 500]: 'assemblyWaitingForMesh',
      },
    },
    // Intermediate state: morph complete, waiting for assembly meshes to be ready
    // Split point cloud stays visible until meshes are loaded and crossfade begins
    assemblyWaitingForMesh: {
      on: {
        assemblyMeshReady: 'assembly',
      },
      // Fallback timeout in case mesh ready event is missed
      after: {
        [timing.crossfadeDuration + 500]: 'assembly',
      },
    },
    assembly: {
      initial: 'animatingIn',
      states: {
        animatingIn: {
          after: {
            [timing.assemblyAnimateInDuration]: 'displaying',
          },
        },
        displaying: {
          after: {
            [timing.assemblyDisplayDuration]: '#authSplashback.fading',
          },
          on: {
            // Re-enter to reset the timer when user interacts
            userInteraction: { target: 'displaying', reenter: true },
          },
        },
      },
    },
    fading: {
      after: {
        [timing.fadeDuration]: 'resetting',
      },
    },
    resetting: {
      after: {
        [timing.resetDelay]: 'prompt1',
      },
    },
  },
});

export type AuthSplashbackActor = typeof authSplashbackMachine;
