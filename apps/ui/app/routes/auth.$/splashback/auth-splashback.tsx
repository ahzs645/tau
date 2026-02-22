import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMachine, useSelector } from '@xstate/react';
import { Check } from 'lucide-react';
import type { KernelConfig, MiddlewareConfig } from '@taucad/types';
import { createDefaultConfig } from '@taucad/kernels';
import { authSplashbackMachine, timing as machineTiming } from '#routes/auth.$/splashback/auth-splashback.machine.js';
import { UnifiedSplashbackViewer } from '#routes/auth.$/splashback/unified-splashback-viewer.js';
import type { SplashbackPhase } from '#routes/auth.$/splashback/unified-splashback-viewer.js';
import { useSampledPoints } from '#routes/auth.$/splashback/use-sampled-points.js';
import { Loader } from '#components/ui/loader.js';
import { CadPreviewProvider, useCadPreview } from '#hooks/use-cad-preview.js';
import { encodeTextFile } from '#utils/filesystem.utils.js';
import gearJscad from '#routes/auth.$/splashback/gear.jscad.js?raw';
import {
  morphPointCount,
  assemblySplitRatio as defaultAssemblySplitRatio,
} from '#routes/auth.$/splashback/auth-splashback.constants.js';

const splashbackConfig = createDefaultConfig({
  kernels: {
    replicad: { enabled: false },
    openscad: { enabled: false },
    zoo: { enabled: false },
    tau: { enabled: false },
  },
  middleware: {
    gltfEdgeDetection: { enabled: false },
  },
});

const jscadOnlyKernelConfig: KernelConfig = splashbackConfig.kernelConfig;

const splashbackMiddlewareConfig: MiddlewareConfig = splashbackConfig.middlewareConfig;

const prompt1Text = 'Create a gear with 12 teeth';
const prompt2Text = 'Change it to 8 teeth';
const prompt3Text = 'Mesh the gears together';

// Tagline text for each stage
const tagline1Text = 'From idea to object in seconds';
const tagline2Text = 'Iterate instantly';
const tagline3Text = 'Bring your designs to life';

const timing = {
  typingDelay: 500,
  typingDuration: 1800,
  fadeDuration: 800,
};

function Cursor(): React.JSX.Element {
  return (
    <motion.span
      className="ml-0.5 inline-block h-[1em] w-[2px] bg-primary pt-0.5"
      animate={{ opacity: [1, 1, 0, 0] }}
      transition={{
        duration: 1,
        repeat: Infinity,
        repeatType: 'loop',
        times: [0, 0.5, 0.5, 1],
      }}
    />
  );
}

type PromptStatusIconProperties = {
  readonly shouldShowEnterKey: boolean;
  readonly shouldShowSpinner: boolean;
  readonly shouldShowCheckmark: boolean;
  readonly onEnterComplete: () => void;
};

/**
 * Unified status icon that smoothly transitions between enter key, spinner, and checkmark.
 * The container stays stable while the inner icon morphs.
 */
function PromptStatusIcon({
  shouldShowEnterKey,
  shouldShowSpinner,
  shouldShowCheckmark,
  onEnterComplete,
}: PromptStatusIconProperties): React.JSX.Element | undefined {
  const showAny = shouldShowEnterKey || shouldShowSpinner || shouldShowCheckmark;

  if (!showAny) {
    return undefined;
  }

  // Determine container styling based on current state - transitions smoothly via CSS
  const containerClass = shouldShowCheckmark
    ? 'border-success/30 bg-success/10'
    : shouldShowSpinner
      ? 'border-primary/30 bg-primary/10'
      : 'bg-muted/50';

  // Determine which icon to show
  const iconType = shouldShowEnterKey ? 'enter' : shouldShowSpinner ? 'spinner' : 'check';

  return (
    <motion.span
      className={`ml-3 inline-flex items-center justify-center rounded-md border p-1 transition-colors duration-200 ${containerClass}`}
      // Key press animation - only y and scale, no opacity changes
      initial={false}
      animate={
        shouldShowEnterKey
          ? {
              y: [0, 4, 0],
              scale: [1, 0.95, 1],
            }
          : { y: 0, scale: 1 }
      }
      transition={
        shouldShowEnterKey
          ? {
              duration: 0.5,
              times: [0, 0.3, 1],
              ease: ['easeIn', 'easeOut'],
            }
          : { duration: 0 }
      }
      onAnimationComplete={shouldShowEnterKey ? onEnterComplete : undefined}
    >
      <AnimatePresence mode="wait" initial={false}>
        {iconType === 'enter' ? (
          <motion.span
            key="enter"
            className="flex size-4 items-center justify-center text-xs text-muted-foreground"
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.08 }}
          >
            ↵
          </motion.span>
        ) : iconType === 'spinner' ? (
          <motion.span
            key="spinner"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.08 }}
            className="flex size-4 items-center justify-center text-muted-foreground"
          >
            <Loader className="size-4" variant="spinner" />
          </motion.span>
        ) : (
          <motion.span
            key="check"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            className="flex size-4 items-center justify-center"
          >
            <Check className="size-4 text-success" />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.span>
  );
}

type TypewriterPromptProperties = {
  readonly text: string;
  readonly isActive: boolean;
  readonly shouldShowEnterKey: boolean;
  readonly shouldShowSpinner: boolean;
  readonly shouldShowCheckmark: boolean;
  readonly shouldReset: boolean;
  readonly onTypingComplete: () => void;
  readonly onEnterComplete: () => void;
};

function TypewriterPrompt({
  text,
  isActive,
  shouldShowEnterKey,
  shouldShowSpinner,
  shouldShowCheckmark,
  shouldReset,
  onTypingComplete,
  onEnterComplete,
}: TypewriterPromptProperties): React.JSX.Element {
  const [displayedText, setDisplayedText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [typingComplete, setTypingComplete] = useState(false);

  // Reset when shouldReset changes to true
  useEffect(() => {
    if (shouldReset) {
      setDisplayedText('');
      setIsTyping(false);
      setTypingComplete(false);
    }
  }, [shouldReset]);

  // Start typing after delay
  useEffect(() => {
    if (!isActive || typingComplete) {
      return;
    }

    const startTimeout = setTimeout(() => {
      setIsTyping(true);
    }, timing.typingDelay);

    return () => {
      clearTimeout(startTimeout);
    };
  }, [isActive, typingComplete]);

  // Typing animation
  useEffect(() => {
    if (!isTyping || !isActive) {
      return;
    }

    const charDelay = timing.typingDuration / text.length;
    let currentIndex = 0;

    const interval = setInterval(() => {
      if (currentIndex < text.length) {
        setDisplayedText(text.slice(0, currentIndex + 1));
        currentIndex++;
      } else {
        clearInterval(interval);
        setIsTyping(false);
        setTypingComplete(true);
        onTypingComplete();
      }
    }, charDelay);

    return () => {
      clearInterval(interval);
    };
  }, [isTyping, isActive, text, onTypingComplete]);

  const shouldShowCursor = isActive && !typingComplete;

  return (
    <div className="flex h-14 items-center gap-3 rounded-full border border-primary/20 bg-background/80 px-5 py-3 backdrop-blur-sm">
      <div className="flex size-2 items-center justify-center">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
      </div>
      <p className="flex items-center font-mono text-sm text-foreground md:text-base">
        <span>{displayedText || <span className="invisible">.</span>}</span>
        {shouldShowCursor ? <Cursor /> : undefined}
        <PromptStatusIcon
          shouldShowEnterKey={shouldShowEnterKey}
          shouldShowSpinner={shouldShowSpinner}
          shouldShowCheckmark={shouldShowCheckmark}
          onEnterComplete={onEnterComplete}
        />
      </p>
    </div>
  );
}

function GridPattern(): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="bg-gradient-radial absolute inset-0 from-transparent via-transparent to-muted/80" />

      <svg className="absolute inset-0 size-full opacity-[0.03]" aria-hidden="true">
        <defs>
          <pattern id="auth-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#auth-grid)" />
      </svg>

      <div className="absolute top-1/2 left-1/2 size-[500px] -translate-x-1/2 -translate-y-1/2">
        <div className="absolute inset-0 animate-pulse-subtle rounded-full border border-primary/5" />
        <div
          className="absolute inset-8 animate-pulse-subtle rounded-full border border-primary/5"
          style={{ animationDelay: '0.5s' }}
        />
        <div
          className="absolute inset-16 animate-pulse-subtle rounded-full border border-primary/5"
          style={{ animationDelay: '1s' }}
        />
      </div>
    </div>
  );
}

type DerivedState = {
  showPrompt1: boolean;
  showPrompt2: boolean;
  showPrompt3: boolean;
  showLoading: boolean;
  showGear12: boolean;
  showGear8: boolean;
  showAssembly: boolean;
  isFading: boolean;
  showContainer: boolean;
  isPrompt1Typing: boolean;
  isPrompt1EnterKey: boolean;
  isPrompt1Spinner: boolean;
  isPrompt1Complete: boolean;
  isPrompt2Typing: boolean;
  isPrompt2EnterKey: boolean;
  isPrompt2Spinner: boolean;
  isPrompt2Complete: boolean;
  isPrompt3Typing: boolean;
  isPrompt3EnterKey: boolean;
  isPrompt3Spinner: boolean;
  isPrompt3Complete: boolean;
  // Morph states
  isPreparingMorph: boolean;
  isMorphingToGear8: boolean;
  isGear8WaitingForMesh: boolean;
  isPreparingMorph2: boolean;
  isMorphingToAssembly: boolean;
  isAssemblyWaitingForMesh: boolean;
  // Current phase for unified viewer
  currentPhase: SplashbackPhase;
};

type AuthSplashbackState = ReturnType<typeof authSplashbackMachine.transition>;

/**
 * Derives all visibility and phase state from the XState machine state.
 * This centralizes state derivation to avoid repeated state.matches() calls in the component.
 */
function deriveVisibilityState(state: AuthSplashbackState): DerivedState {
  // === Morph transition states ===
  const isPreparingMorph = state.matches('preparingMorph');
  const isMorphingToGear8 = state.matches('morphingToGear8');
  const isGear8WaitingForMesh = state.matches('gear8WaitingForMesh');
  const isPreparingMorph2 = state.matches('preparingMorph2');
  const isMorphingToAssembly = state.matches('morphingToAssembly');
  const isAssemblyWaitingForMesh = state.matches('assemblyWaitingForMesh');

  // Group morph states for convenience
  const isMorphingToGear8Phase = isPreparingMorph || isMorphingToGear8 || isGear8WaitingForMesh;
  const isMorphingToAssemblyPhase = isPreparingMorph2 || isMorphingToAssembly || isAssemblyWaitingForMesh;

  // === Basic visibility states ===
  const showLoading = state.matches('loading');
  const showGear12 = state.matches('gear12');
  const showGear8 =
    state.matches({ gear8: 'animatingIn' }) ||
    state.matches({ gear8: 'displaying' }) ||
    state.matches({ gear8: 'prompt3' });
  const showAssembly = state.matches('assembly');
  const isFading = state.matches('fading');

  // === Prompt visibility (each prompt stays visible through its associated transitions) ===
  const showPrompt1 =
    state.matches('prompt1') ||
    showLoading ||
    state.matches({ gear12: 'animatingIn' }) ||
    state.matches({ gear12: 'displaying' });

  // Prompt2 should NOT include gear8.prompt3 - that's when prompt3 takes over
  const showPrompt2 =
    state.matches({ gear12: 'prompt2' }) ||
    isMorphingToGear8Phase ||
    state.matches({ gear8: 'animatingIn' }) ||
    state.matches({ gear8: 'displaying' });

  const showPrompt3 = state.matches({ gear8: 'prompt3' }) || isMorphingToAssemblyPhase || showAssembly || isFading;

  // Container stays mounted during all visible states and transitions
  const showContainer =
    showLoading ||
    showGear12 ||
    showGear8 ||
    showAssembly ||
    isFading ||
    isMorphingToGear8Phase ||
    isMorphingToAssemblyPhase;

  // === Prompt 1 status icon states ===
  const isPrompt1Typing = state.matches({ prompt1: 'typing' });
  const isPrompt1EnterKey = state.matches({ prompt1: 'enterKey' });
  const isPrompt1Spinner = showLoading;
  const isPrompt1Complete =
    state.matches({ gear12: 'animatingIn' }) ||
    state.matches({ gear12: 'displaying' }) ||
    state.matches({ gear12: 'prompt2' });

  // === Prompt 2 status icon states ===
  const isPrompt2Typing = state.matches({ gear12: { prompt2: 'typing' } });
  const isPrompt2EnterKey = state.matches({ gear12: { prompt2: 'enterKey' } });
  const isPrompt2Spinner = isMorphingToGear8Phase;
  const isPrompt2Complete = showGear8;

  // === Prompt 3 status icon states ===
  const isPrompt3Typing = state.matches({ gear8: { prompt3: 'typing' } });
  const isPrompt3EnterKey = state.matches({ gear8: { prompt3: 'enterKey' } });
  const isPrompt3Spinner = isMorphingToAssemblyPhase;
  const isPrompt3Complete =
    state.matches({ assembly: 'animatingIn' }) || state.matches({ assembly: 'displaying' }) || isFading;

  // === Current phase for unified viewer ===
  const currentPhase = deriveCurrentPhase({
    showLoading,
    showGear12,
    showGear8,
    showAssembly,
    isFading,
    isPreparingMorph,
    isMorphingToGear8,
    isGear8WaitingForMesh,
    isPreparingMorph2,
    isMorphingToAssembly,
    isAssemblyWaitingForMesh,
  });

  return {
    showPrompt1,
    showPrompt2,
    showPrompt3,
    showLoading,
    showGear12,
    showGear8,
    showAssembly,
    isFading,
    showContainer,
    isPrompt1Typing,
    isPrompt1EnterKey,
    isPrompt1Spinner,
    isPrompt1Complete,
    isPrompt2Typing,
    isPrompt2EnterKey,
    isPrompt2Spinner,
    isPrompt2Complete,
    isPrompt3Typing,
    isPrompt3EnterKey,
    isPrompt3Spinner,
    isPrompt3Complete,
    isPreparingMorph,
    isMorphingToGear8,
    isGear8WaitingForMesh,
    isPreparingMorph2,
    isMorphingToAssembly,
    isAssemblyWaitingForMesh,
    currentPhase,
  };
}

type PhaseFlags = {
  showLoading: boolean;
  showGear12: boolean;
  showGear8: boolean;
  showAssembly: boolean;
  isFading: boolean;
  isPreparingMorph: boolean;
  isMorphingToGear8: boolean;
  isGear8WaitingForMesh: boolean;
  isPreparingMorph2: boolean;
  isMorphingToAssembly: boolean;
  isAssemblyWaitingForMesh: boolean;
};

/**
 * Derives the current phase for the unified splashback viewer.
 * Priority order matters - more specific states checked first.
 */
function deriveCurrentPhase(flags: PhaseFlags): SplashbackPhase {
  // Transition states have highest priority
  if (flags.showLoading) {
    return 'loading';
  }

  if (flags.isPreparingMorph) {
    return 'preparingMorph';
  }

  if (flags.isMorphingToGear8) {
    return 'morphing';
  }

  if (flags.isGear8WaitingForMesh) {
    return 'crossfading';
  }

  if (flags.isPreparingMorph2) {
    return 'preparingMorph2';
  }

  if (flags.isMorphingToAssembly) {
    return 'morphingToAssembly';
  }

  if (flags.isAssemblyWaitingForMesh) {
    return 'crossfadingToAssembly';
  }

  // Display states
  if (flags.showAssembly) {
    return 'assembly';
  }

  if (flags.isFading) {
    return 'fading';
  }

  if (flags.showGear8) {
    return 'gear8';
  }

  if (flags.showGear12) {
    return 'gear12';
  }

  return 'loading';
}

type AuthSplashbackSend = ReturnType<typeof useMachine<typeof authSplashbackMachine>>[1];

type AuthSplashbackContentProperties = {
  readonly state: ReturnType<typeof authSplashbackMachine.transition>;
  readonly send: AuthSplashbackSend;
  readonly derivedState: DerivedState;
};

function AuthSplashbackContent({ state, send, derivedState }: AuthSplashbackContentProperties): React.JSX.Element {
  const { geometries, status: cadStatus } = useCadPreview();

  const {
    showPrompt1,
    showPrompt2,
    showPrompt3,
    showLoading,
    isFading,
    showContainer,
    isPrompt1Typing,
    isPrompt1EnterKey,
    isPrompt1Spinner,
    isPrompt1Complete,
    isPrompt2Typing,
    isPrompt2EnterKey,
    isPrompt2Spinner,
    isPrompt2Complete,
    isPrompt3Typing,
    isPrompt3EnterKey,
    isPrompt3Spinner,
    isPrompt3Complete,
    isPreparingMorph,
    isMorphingToGear8,
    isGear8WaitingForMesh,
    isPreparingMorph2,
    isMorphingToAssembly,
    isAssemblyWaitingForMesh,
    showGear8,
    showAssembly,
    currentPhase,
  } = derivedState;

  const gear12Geometry = geometries[0];
  const gear8Geometry = geometries[1];

  const { gear12Points, gear8Points, assemblyGear12Points, assemblyGear8Points, assemblySplitRatio } = useSampledPoints(
    {
      gear12Geometry,
      gear8Geometry,
      pointCount: morphPointCount,
      assemblySplitRatio: defaultAssemblySplitRatio,
    },
  );

  const isMorphingToAssemblyPhase = isPreparingMorph2 || isMorphingToAssembly || isAssemblyWaitingForMesh;
  const isMorphingToGear8Phase = isPreparingMorph || isMorphingToGear8 || isGear8WaitingForMesh;
  const isAssemblyMode = showAssembly || isFading;
  const is8TeethMode = showGear8 || isMorphingToAssemblyPhase;
  const is12TeethMode = showLoading || isMorphingToGear8Phase;
  const currentTagline = isAssemblyMode
    ? tagline3Text
    : is8TeethMode
      ? tagline2Text
      : is12TeethMode
        ? tagline1Text
        : tagline1Text;

  const handleTypingComplete = useCallback(() => {
    send({ type: 'typingComplete' });
  }, [send]);

  const handleEnterComplete = useCallback(() => {
    send({ type: 'enterComplete' });
  }, [send]);

  const handleInteraction = useCallback(() => {
    send({ type: 'userInteraction' });
  }, [send]);

  useEffect(() => {
    if (isPreparingMorph && gear12Points && gear8Points) {
      send({ type: 'geometriesReady' });
    }
  }, [isPreparingMorph, gear12Points, gear8Points, send]);

  useEffect(() => {
    if (isPreparingMorph2 && gear8Points && assemblyGear12Points && assemblyGear8Points) {
      send({ type: 'geometriesReady' });
    }
  }, [isPreparingMorph2, gear8Points, assemblyGear12Points, assemblyGear8Points, send]);

  const handleMorphComplete = useCallback(() => {
    send({ type: 'morphComplete' });
  }, [send]);

  const handleCrossfadeComplete = useCallback(
    (_finalRotationY: number) => {
      send({ type: 'gear8MeshReady' });
    },
    [send],
  );

  const handleMorph2Complete = useCallback(() => {
    send({ type: 'morph2Complete' });
  }, [send]);

  const handlePhaseTransitionComplete = useCallback(() => {
    if (isAssemblyWaitingForMesh) {
      send({ type: 'assemblyMeshReady' });
    }
  }, [send, isAssemblyWaitingForMesh]);

  return (
    <div className="relative flex size-full items-center justify-center overflow-hidden bg-muted" aria-hidden="true">
      <GridPattern />

      <motion.div
        className="relative z-10 flex flex-col items-center gap-4 md:gap-5"
        animate={{ opacity: isFading ? 0 : 1 }}
        transition={{ duration: timing.fadeDuration / 1000 }}
      >
        {/* Prompt Bubbles */}
        <div className="flex min-h-[52px] items-center justify-center px-6">
          <AnimatePresence mode="wait">
            {showPrompt1 ? (
              <motion.div
                key="prompt1"
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                initial={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.3 }}
              >
                <TypewriterPrompt
                  isActive={isPrompt1Typing}
                  shouldReset={state.matches({ prompt1: 'typing' })}
                  shouldShowCheckmark={isPrompt1Complete}
                  shouldShowEnterKey={isPrompt1EnterKey}
                  shouldShowSpinner={isPrompt1Spinner}
                  text={prompt1Text}
                  onEnterComplete={handleEnterComplete}
                  onTypingComplete={handleTypingComplete}
                />
              </motion.div>
            ) : undefined}
            {showPrompt2 ? (
              <motion.div
                key="prompt2"
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                initial={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.3 }}
              >
                <TypewriterPrompt
                  isActive={isPrompt2Typing}
                  shouldReset={state.matches({ gear12: { prompt2: 'typing' } })}
                  shouldShowCheckmark={isPrompt2Complete}
                  shouldShowEnterKey={isPrompt2EnterKey}
                  shouldShowSpinner={isPrompt2Spinner}
                  text={prompt2Text}
                  onEnterComplete={handleEnterComplete}
                  onTypingComplete={handleTypingComplete}
                />
              </motion.div>
            ) : undefined}
            {showPrompt3 ? (
              <motion.div
                key="prompt3"
                animate={{ opacity: isFading ? 0 : 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                initial={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.3 }}
              >
                <TypewriterPrompt
                  isActive={isPrompt3Typing}
                  shouldReset={state.matches({ gear8: { prompt3: 'typing' } })}
                  shouldShowCheckmark={isPrompt3Complete}
                  shouldShowEnterKey={isPrompt3EnterKey}
                  shouldShowSpinner={isPrompt3Spinner}
                  text={prompt3Text}
                  onEnterComplete={handleEnterComplete}
                  onTypingComplete={handleTypingComplete}
                />
              </motion.div>
            ) : undefined}
          </AnimatePresence>
        </div>

        {/* Visualization Container */}
        <motion.div
          className={`flex items-center justify-center overflow-hidden rounded-xl border bg-background/90 backdrop-blur-sm transition-opacity duration-400 ${
            showContainer ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
          animate={{ opacity: isFading ? 0 : showContainer ? 1 : 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          <div className="relative size-72 md:size-80 lg:size-128">
            <AnimatePresence>
              {showLoading || cadStatus === 'loading' ? (
                <motion.div
                  key="loading"
                  className="absolute inset-0 z-10 flex items-center justify-center bg-background/50"
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  initial={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <Loader className="size-16" />
                </motion.div>
              ) : undefined}
            </AnimatePresence>

            {showContainer && gear12Geometry && gear8Geometry ? (
              <UnifiedSplashbackViewer
                phase={currentPhase}
                gear12Geometry={gear12Geometry}
                gear8Geometry={gear8Geometry}
                gear12Points={gear12Points}
                gear8Points={gear8Points}
                assemblyGear12Points={assemblyGear12Points}
                assemblyGear8Points={assemblyGear8Points}
                assemblySplitRatio={assemblySplitRatio}
                crossfadeDuration={machineTiming.crossfadeDuration}
                className="size-full"
                onInteraction={handleInteraction}
                onMorphComplete={handleMorphComplete}
                onCrossfadeComplete={handleCrossfadeComplete}
                onMorph2Complete={handleMorph2Complete}
                onPhaseTransitionComplete={handlePhaseTransitionComplete}
              />
            ) : undefined}
          </div>
        </motion.div>

        {/* Tagline */}
        <div className="relative flex h-6 w-full items-center justify-center">
          <AnimatePresence mode="wait">
            {showContainer && !isFading ? (
              <motion.p
                key={currentTagline}
                className="text-md absolute text-center whitespace-nowrap text-muted-foreground"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                {currentTagline}
              </motion.p>
            ) : undefined}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

export function AuthSplashback(): React.JSX.Element {
  const [state, send, actorRef] = useMachine(authSplashbackMachine);
  const derivedState = useSelector(actorRef, deriveVisibilityState);

  const gearFiles = useMemo(() => {
    const mainFileName = 'main.js';
    return { [mainFileName]: { content: encodeTextFile(gearJscad) } };
  }, []);

  return (
    <CadPreviewProvider
      buildId="auth-gears"
      mainFile="main.js"
      files={gearFiles}
      isEnabled={derivedState.showContainer}
      kernelConfig={jscadOnlyKernelConfig}
      middlewareConfig={splashbackMiddlewareConfig}
    >
      <AuthSplashbackContent state={state} send={send} derivedState={derivedState} />
    </CadPreviewProvider>
  );
}
