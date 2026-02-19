import { Activity, ChevronRight, XIcon } from 'lucide-react';
import { memo, useCallback, useRef, useState } from 'react';
import { useSelector } from '@xstate/react';
import type { ActorRefFrom } from 'xstate';
import { Allotment } from 'allotment';
import type { AllotmentHandle } from 'allotment';
import type { RenderPhase } from '@taucad/types';
import {
  FloatingPanel,
  FloatingPanelClose,
  FloatingPanelContent,
  FloatingPanelContentBody,
  FloatingPanelContentHeader,
  FloatingPanelContentHeaderActions,
  FloatingPanelContentTitle,
  FloatingPanelTrigger,
} from '#components/ui/floating-panel.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';
import { cn } from '#utils/ui.utils.js';
import { useBuild } from '#hooks/use-build.js';
import { ChatConsole } from '#routes/builds_.$id/chat-console.js';
import type { cadMachine } from '#machines/cad.machine.js';

const phaseLabels: Record<RenderPhase, string> = {
  resolvingDeps: 'Resolving Dependencies',
  bundling: 'Bundling',
  extractingParams: 'Extracting Parameters',
  computingGeometry: 'Computing Geometry',
  postProcessing: 'Post-Processing',
};

const phaseOrder: RenderPhase[] = [
  'resolvingDeps',
  'bundling',
  'extractingParams',
  'computingGeometry',
  'postProcessing',
];

function formatDuration(ms: number): string {
  if (ms < 1) {
    return '<1ms';
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  return `${(ms / 1000).toFixed(2)}s`;
}

function PipelineTimingBar({
  phase,
  duration,
  maxDuration,
}: {
  readonly phase: RenderPhase;
  readonly duration: number;
  readonly maxDuration: number;
}): React.JSX.Element {
  const widthPercent = maxDuration > 0 ? Math.max(2, (duration / maxDuration) * 100) : 0;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-36 shrink-0 truncate text-muted-foreground">{phaseLabels[phase]}</span>
      <div className="relative h-4 flex-1 overflow-hidden rounded-sm bg-muted">
        <div
          className="h-full rounded-sm bg-primary/60 transition-all duration-300"
          style={{ width: `${widthPercent}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-muted-foreground">{formatDuration(duration)}</span>
    </div>
  );
}

function CompilationUnitTiming({ cadRef }: { readonly cadRef: ActorRefFrom<typeof cadMachine> }): React.JSX.Element {
  const renderPhase = useSelector(cadRef, (state) => state.context.renderPhase);
  const renderPhaseDurations = useSelector(cadRef, (state) => state.context.renderPhaseDurations);
  const telemetryEntries = useSelector(cadRef, (state) => state.context.telemetryEntries);

  const maxDuration = Math.max(...renderPhaseDurations.values(), 1);
  const totalDuration = [...renderPhaseDurations.values()].reduce((sum, d) => sum + d, 0);
  const visiblePhases = phaseOrder.filter((p) => renderPhaseDurations.has(p));

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Render Pipeline</span>
        {renderPhase ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {phaseLabels[renderPhase]}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Idle</span>
        )}
      </div>

      {visiblePhases.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {visiblePhases.map((phase) => (
            <PipelineTimingBar
              key={phase}
              phase={phase}
              duration={renderPhaseDurations.get(phase) ?? 0}
              maxDuration={maxDuration}
            />
          ))}
          <div className="mt-1 flex items-center justify-between border-t border-border pt-1.5">
            <span className="text-xs font-medium text-muted-foreground">Total</span>
            <span className="font-mono text-xs font-medium text-foreground">{formatDuration(totalDuration)}</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No render data yet.</p>
      )}

      {telemetryEntries.length > 0 && (
        <div className="mt-2">
          <span className="mb-1.5 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Telemetry
          </span>
          <div className="flex flex-col gap-1">
            {telemetryEntries.map((entry, index) => (
              <div key={`${entry.name}-${String(index)}`} className="flex items-center justify-between text-xs">
                <span className="truncate font-mono text-muted-foreground">{entry.name}</span>
                <span className="shrink-0 font-mono text-muted-foreground">{formatDuration(entry.duration)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CompilationUnitSummary({ cadRef }: { readonly cadRef: ActorRefFrom<typeof cadMachine> }): React.JSX.Element {
  const renderPhase = useSelector(cadRef, (state) => state.context.renderPhase);
  const renderPhaseDurations = useSelector(cadRef, (state) => state.context.renderPhaseDurations);

  const totalDuration = [...renderPhaseDurations.values()].reduce((sum, d) => sum + d, 0);

  if (renderPhase) {
    return <span className="shrink-0 text-xs text-primary">{phaseLabels[renderPhase]}...</span>;
  }

  if (totalDuration > 0) {
    return <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatDuration(totalDuration)}</span>;
  }

  return <span className="shrink-0 text-xs text-muted-foreground">Idle</span>;
}

function KernelCollapsibleSection({
  entryFile,
  cadRef,
  isOpen,
  onOpenChange,
}: {
  readonly entryFile: string;
  readonly cadRef: ActorRefFrom<typeof cadMachine>;
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
}): React.JSX.Element {
  return (
    <Collapsible open={isOpen} className="w-full border-b border-border/50 last:border-b-0" onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="group/collapsible flex h-8 w-full items-center justify-between px-3 py-1.5 transition-colors hover:bg-muted/50">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-in-out group-data-[state=open]/collapsible:rotate-90" />
          <span className="truncate text-xs font-medium text-foreground">{entryFile}</span>
        </div>
        <CompilationUnitSummary cadRef={cadRef} />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-0 py-0">
        <CompilationUnitTiming cadRef={cadRef} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function KernelCompilationUnits(): React.JSX.Element {
  const { compilationUnits } = useBuild();
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const toggleSection = (entryFile: string, isOpen: boolean): void => {
    setOpenSections((previous) => {
      const next = new Set(previous);
      if (isOpen) {
        next.add(entryFile);
      } else {
        next.delete(entryFile);
      }

      return next;
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      {[...compilationUnits.entries()].map(([entryFile, cadRef]) => (
        <KernelCollapsibleSection
          key={entryFile}
          entryFile={entryFile}
          cadRef={cadRef}
          isOpen={openSections.has(entryFile)}
          onOpenChange={(isOpen) => {
            toggleSection(entryFile, isOpen);
          }}
        />
      ))}
    </div>
  );
}

export const ChatKernelTrigger = memo(function ({
  isOpen,
  onToggle,
}: {
  readonly isOpen: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  return (
    <FloatingPanelTrigger
      icon={Activity}
      tooltipContent={<div className="flex items-center gap-2">{isOpen ? 'Close' : 'Open'} Kernel</div>}
      tooltipSide="right"
      className={isOpen ? 'text-primary' : undefined}
      onClick={onToggle}
    />
  );
});

// eslint-disable-next-line @typescript-eslint/naming-convention -- layout constant
const CONSOLE_COLLAPSED_SIZE = 44;

export const ChatKernel = memo(function ({
  isExpanded,
  setIsExpanded,
  className,
}: {
  readonly isExpanded: boolean;
  readonly setIsExpanded: (isExpanded: boolean | ((previous: boolean) => boolean)) => void;
  readonly className?: string;
}): React.JSX.Element {
  const allotmentRef = useRef<AllotmentHandle>(null);
  const [isConsoleCollapsed, setIsConsoleCollapsed] = useState(true);

  const toggleConsole = useCallback(() => {
    setIsConsoleCollapsed((previous) => {
      const next = !previous;
      if (next) {
        allotmentRef.current?.resize([Number.MAX_SAFE_INTEGER, CONSOLE_COLLAPSED_SIZE]);
      } else {
        allotmentRef.current?.reset();
      }

      return next;
    });
  }, []);

  return (
    <FloatingPanel isOpen={isExpanded} side="right" onOpenChange={setIsExpanded}>
      <FloatingPanelContent className={cn('flex h-full flex-col', className)}>
        <FloatingPanelContentHeader>
          <FloatingPanelContentTitle>Kernel</FloatingPanelContentTitle>
          <FloatingPanelContentHeaderActions>
            <FloatingPanelClose
              icon={XIcon}
              tooltipContent={(isOpen) => (
                <div className="flex items-center gap-2">{isOpen ? 'Close' : 'Open'} Kernel</div>
              )}
            />
          </FloatingPanelContentHeaderActions>
        </FloatingPanelContentHeader>

        <FloatingPanelContentBody className="flex-1 overflow-hidden p-0">
          <Allotment ref={allotmentRef} vertical defaultSizes={[Number.MAX_SAFE_INTEGER, CONSOLE_COLLAPSED_SIZE]}>
            <Allotment.Pane minSize={100}>
              <KernelCompilationUnits />
            </Allotment.Pane>
            <Allotment.Pane minSize={CONSOLE_COLLAPSED_SIZE}>
              <ChatConsole onButtonClick={toggleConsole} />
            </Allotment.Pane>
          </Allotment>
        </FloatingPanelContentBody>
      </FloatingPanelContent>
    </FloatingPanel>
  );
});
