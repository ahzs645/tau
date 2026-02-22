import {
  Activity,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ListFilter,
  Settings2,
  Terminal,
  XIcon,
} from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useSelector } from '@xstate/react';
import type { ActorRefFrom } from 'xstate';
import type { RenderPhase, LogEntry, PerformanceEntryData } from '@taucad/types';
import { logLevels } from '@taucad/types/constants';
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
import { SearchInput } from '#components/search-input.js';
import { HighlightText } from '#components/highlight-text.js';
import { PaneButton } from '#components/ui/pane-button.js';
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group.js';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover.js';
import { TraceConditionPicker } from '#components/kernel/trace-condition-picker.js';
import type { FilterCondition } from '#components/kernel/trace-condition-picker.js';
import { cn } from '#utils/ui.utils.js';
import { useBuild } from '#hooks/use-build.js';
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

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

const logLevelColors: Record<string, string> = {
  [logLevels.error]: 'text-destructive',
  [logLevels.warn]: 'text-warning',
  [logLevels.info]: 'text-primary',
  [logLevels.debug]: 'text-muted-foreground',
  [logLevels.trace]: 'text-muted-foreground/60',
};

// ---------------------------------------------------------------------------
// Telemetry span tree
// ---------------------------------------------------------------------------

type SpanNode = {
  entry: PerformanceEntryData;
  children: SpanNode[];
  depth: number;
  selfTime: number;
};

function getSpanId(entry: PerformanceEntryData): string | undefined {
  return entry.detail?.['spanId'] as string | undefined;
}

function getParentSpanId(entry: PerformanceEntryData): string | undefined {
  return entry.detail?.['parentSpanId'] as string | undefined;
}

function computeSelfTime(node: SpanNode): number {
  const childrenTotal = node.children.reduce((sum, child) => sum + child.entry.duration, 0);
  return Math.max(0, node.entry.duration - childrenTotal);
}

function assignDepths(node: SpanNode, depth: number): void {
  node.depth = depth;
  for (const child of node.children) {
    assignDepths(child, depth + 1);
  }
}

function buildSpanTree(entries: PerformanceEntryData[]): SpanNode[] {
  const nodes: SpanNode[] = entries.map((entry) => ({
    entry,
    children: [],
    depth: 0,
    selfTime: 0,
  }));

  const byId = new Map<string, SpanNode>();
  for (const node of nodes) {
    const spanId = getSpanId(node.entry);
    if (spanId) {
      byId.set(spanId, node);
    }
  }

  const roots: SpanNode[] = [];
  for (const node of nodes) {
    const parentId = getParentSpanId(node.entry);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const root of roots) {
    assignDepths(root, 0);
  }

  for (const node of nodes) {
    node.selfTime = computeSelfTime(node);
  }

  return roots;
}

// ---------------------------------------------------------------------------
// Pipeline phase derivation from telemetry spans
// ---------------------------------------------------------------------------

type PipelineData = {
  phaseDurations: Map<RenderPhase, number>;
  totalDuration: number;
};

const emptyPipelineData: PipelineData = {
  phaseDurations: new Map(),
  totalDuration: 0,
};

function derivePhaseDurations(entries: PerformanceEntryData[]): PipelineData {
  if (entries.length === 0) {
    return emptyPipelineData;
  }

  let renderDuration = 0;
  const phaseDurations = new Map<RenderPhase, number>();

  for (const entry of entries) {
    if (entry.name === 'kernel.render') {
      renderDuration = entry.duration;
    }

    const phase = entry.detail?.['phase'] as RenderPhase | undefined;
    if (phase) {
      phaseDurations.set(phase, (phaseDurations.get(phase) ?? 0) + entry.duration);
    }
  }

  if (renderDuration === 0) {
    return emptyPipelineData;
  }

  const classified = [...phaseDurations.values()].reduce((sum, d) => sum + d, 0);
  const postProcessing = Math.max(0, renderDuration - classified);
  if (postProcessing > 0) {
    phaseDurations.set('postProcessing', postProcessing);
  }

  return { phaseDurations, totalDuration: renderDuration };
}

const pipelineMemoCache = new WeakMap<PerformanceEntryData[], PipelineData>();

function selectPipelineData(state: { context: { telemetryEntries: PerformanceEntryData[] } }): PipelineData {
  const entries = state.context.telemetryEntries;
  if (entries.length === 0) {
    return emptyPipelineData;
  }

  const cached = pipelineMemoCache.get(entries);
  if (cached) {
    return cached;
  }

  const result = derivePhaseDurations(entries);
  pipelineMemoCache.set(entries, result);
  return result;
}

// ---------------------------------------------------------------------------
// Span categories & display
// ---------------------------------------------------------------------------

type SpanCategory = 'framework' | 'middleware' | 'kernel' | 'fs' | 'deps';

function getSpanCategory(name: string): SpanCategory {
  if (name.startsWith('kernel.') || name.startsWith('wasm.')) {
    return 'framework';
  }

  if (name.startsWith('middleware.')) {
    return 'middleware';
  }

  if (name.startsWith('fs.')) {
    return 'fs';
  }

  if (name.startsWith('deps.')) {
    return 'deps';
  }

  return 'kernel';
}

const categoryDotColors: Record<SpanCategory, string> = {
  framework: 'bg-primary',
  kernel: 'bg-success',
  middleware: 'bg-warning',
  fs: 'bg-muted-foreground/40',
  deps: 'bg-information',
};

const categorySvgColors: Record<SpanCategory, string> = {
  framework: 'var(--color-primary)',
  kernel: 'var(--color-success)',
  middleware: 'var(--color-warning)',
  fs: 'var(--color-muted-foreground)',
  deps: 'var(--color-information)',
};

// ---------------------------------------------------------------------------
// Display Settings
// ---------------------------------------------------------------------------

type DisplaySettings = {
  showLatency: boolean;
  showSelfTime: boolean;
  showAttributes: boolean;
  visibility: 'all' | 'relevant';
};

const defaultDisplaySettings: DisplaySettings = {
  showLatency: true,
  showSelfTime: true,
  showAttributes: false,
  visibility: 'all',
};

type ViewMode = 'standard' | 'waterfall';

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function matchesCondition(node: SpanNode, condition: FilterCondition): boolean {
  if (!condition.value) {
    return true;
  }

  const { field, operator, value } = condition;

  switch (field) {
    case 'latency': {
      const ms = node.entry.duration;
      const target = Number.parseFloat(value);
      if (Number.isNaN(target)) {
        return true;
      }

      return applyNumericOp(ms, operator, target);
    }

    case 'selfTime': {
      const target = Number.parseFloat(value);
      if (Number.isNaN(target)) {
        return true;
      }

      return applyNumericOp(node.selfTime, operator, target);
    }

    case 'name': {
      if (operator === 'contains') {
        return node.entry.name.toLowerCase().includes(value.toLowerCase());
      }

      return node.entry.name === value;
    }

    case 'category': {
      return getSpanCategory(node.entry.name) === value;
    }

    default: {
      return true;
    }
  }
}

function applyNumericOp(actual: number, operator: string, target: number): boolean {
  switch (operator) {
    case '>': {
      return actual > target;
    }

    case '>=': {
      return actual >= target;
    }

    case '<': {
      return actual < target;
    }

    case '<=': {
      return actual <= target;
    }

    case '=': {
      return Math.abs(actual - target) < 0.5;
    }

    default: {
      return true;
    }
  }
}

function filterSpanTree(roots: SpanNode[], conditions: FilterCondition[]): SpanNode[] {
  if (conditions.length === 0) {
    return roots;
  }

  function nodeMatches(node: SpanNode): boolean {
    return conditions.every((c) => matchesCondition(node, c));
  }

  function filterNode(node: SpanNode): SpanNode | undefined {
    const filteredChildren = node.children.map((child) => filterNode(child)).filter(Boolean) as SpanNode[];

    if (nodeMatches(node) || filteredChildren.length > 0) {
      return { ...node, children: filteredChildren };
    }

    return undefined;
  }

  return roots.map((root) => filterNode(root)).filter(Boolean) as SpanNode[];
}

function applyVisibility(roots: SpanNode[], visibility: 'all' | 'relevant'): SpanNode[] {
  if (visibility === 'all') {
    return roots;
  }

  function filterRelevant(node: SpanNode): SpanNode | undefined {
    const filteredChildren = node.children.map((child) => filterRelevant(child)).filter(Boolean) as SpanNode[];

    if (node.entry.duration >= 1 || filteredChildren.length > 0) {
      return { ...node, children: filteredChildren };
    }

    return undefined;
  }

  return roots.map((root) => filterRelevant(root)).filter(Boolean) as SpanNode[];
}

// ---------------------------------------------------------------------------
// Flatten tree for waterfall
// ---------------------------------------------------------------------------

function flattenSpanTree(roots: SpanNode[], collapsedSet: Set<string>): SpanNode[] {
  const result: SpanNode[] = [];

  function walk(node: SpanNode): void {
    result.push(node);
    const spanId = getSpanId(node.entry);
    const isCollapsed = spanId ? collapsedSet.has(spanId) : false;
    if (!isCollapsed) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  for (const root of roots) {
    walk(root);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

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
      <span className="w-32 shrink-0 truncate text-muted-foreground">{phaseLabels[phase]}</span>
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

function CompilationUnitLogs({ entryFile }: { readonly entryFile: string }): React.JSX.Element {
  const { logRef } = useBuild();
  const logVersion = useSelector(logRef, (state) => state.context.logVersion);
  const [filter, setFilter] = useState('');
  const [isFilterVisible, setIsFilterVisible] = useState(false);

  const cuLogs = useMemo(() => {
    const all = logRef.getSnapshot().context.logBuffer.toArray();
    return all.filter((log: LogEntry) => log.origin?.file === entryFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- logVersion tracks buffer mutations
  }, [logRef, logVersion, entryFile]);

  const filteredLogs = useMemo(() => {
    if (!filter) {
      return cuLogs;
    }

    const filterLower = filter.toLowerCase();
    return cuLogs.filter((log: LogEntry) => {
      const messageMatch = log.message.toLowerCase().includes(filterLower);
      const componentMatch = log.origin?.component?.toLowerCase().includes(filterLower) ?? false;
      return messageMatch || componentMatch;
    });
  }, [cuLogs, filter]);

  const handleFilterChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setFilter(event.target.value);
  }, []);

  const handleClearFilter = useCallback(() => {
    setFilter('');
  }, []);

  const toggleFilter = useCallback(() => {
    setIsFilterVisible((previous) => {
      if (previous) {
        setFilter('');
      }

      return !previous;
    });
  }, []);

  return (
    <div className="flex flex-col gap-1 p-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Terminal className="size-3 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Console</span>
          {cuLogs.length > 0 ? (
            <span className="ml-0.5 text-[10px] text-muted-foreground/50 tabular-nums">{cuLogs.length}</span>
          ) : undefined}
        </div>
        <PaneButton
          tooltip="Filter logs"
          className={cn('size-5', isFilterVisible && 'text-primary')}
          onClick={toggleFilter}
        >
          <ListFilter className="size-3" />
        </PaneButton>
      </div>

      {isFilterVisible ? (
        <SearchInput
          autoComplete="off"
          className="h-6 w-full bg-background text-xs"
          placeholder="Filter logs..."
          value={filter}
          onChange={handleFilterChange}
          onClear={handleClearFilter}
        />
      ) : undefined}

      {filteredLogs.length > 0 ? (
        <div className="flex max-h-48 flex-col overflow-y-auto">
          {filteredLogs.map((log: LogEntry) => (
            <div key={log.id} className="group flex items-start gap-1.5 py-[3px] pr-2 text-xs hover:bg-muted/30">
              <span className="shrink-0 font-mono text-[10px] leading-4 text-muted-foreground/40">
                {formatTimestamp(log.timestamp)}
              </span>
              <span className={cn('flex-1 leading-4 break-all', logLevelColors[log.level] ?? 'text-foreground')}>
                <HighlightText text={log.message} searchTerm={filter} />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="py-2 text-center text-[11px] text-muted-foreground/60">
          {cuLogs.length > 0 ? 'No matching logs.' : 'No logs yet.'}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Standard Tree View
// ---------------------------------------------------------------------------

function SpanAttributeBadges({ entry }: { readonly entry: PerformanceEntryData }): React.JSX.Element | undefined {
  const attributes = entry.detail;
  if (!attributes) {
    return undefined;
  }

  const displayKeys = Object.keys(attributes).filter((k) => !['spanId', 'parentSpanId', 'devtools'].includes(k));

  if (displayKeys.length === 0) {
    return undefined;
  }

  return (
    <span className="inline-flex min-w-0 shrink gap-1 overflow-hidden">
      {displayKeys.slice(0, 2).map((key) => (
        <span key={key} className="shrink-0 rounded bg-muted/80 px-1 py-px text-[10px] text-muted-foreground">
          {String(attributes[key]).length > 20 ? `${key}` : `${key}=${String(attributes[key])}`}
        </span>
      ))}
    </span>
  );
}

function StandardSpanNode({
  node,
  collapsedSet,
  onToggle,
  displaySettings,
  isLast,
  ancestorIsLast,
}: {
  readonly node: SpanNode;
  readonly collapsedSet: Set<string>;
  readonly onToggle: (spanId: string) => void;
  readonly displaySettings: DisplaySettings;
  readonly isLast: boolean;
  readonly ancestorIsLast: boolean[];
}): React.JSX.Element {
  const spanId = getSpanId(node.entry);
  const hasChildren = node.children.length > 0;
  const isCollapsed = spanId ? collapsedSet.has(spanId) : false;
  const category = getSpanCategory(node.entry.name);

  return (
    <>
      <div
        className={cn('group relative flex items-center py-[3px] pr-2 text-xs', hasChildren && 'cursor-pointer')}
        onClick={
          hasChildren && spanId
            ? () => {
                onToggle(spanId);
              }
            : undefined
        }
      >
        {/* Tree connector lines */}
        {Array.from({ length: node.depth }, (_, i) => (
          <span key={String(i)} className="relative flex h-full w-5 shrink-0 items-center justify-center">
            {ancestorIsLast[i] ? undefined : <span className="absolute inset-y-0 left-2.5 w-px bg-border" />}
          </span>
        ))}

        {node.depth > 0 && (
          <span className="absolute flex items-center" style={{ left: (node.depth - 1) * 20 + 10 }}>
            <span
              className={cn('inline-block w-px bg-border', isLast ? 'h-1/2 self-start' : 'h-full')}
              style={{ position: 'absolute', top: 0, height: isLast ? '50%' : '100%' }}
            />
            <span
              className="inline-block h-px bg-border"
              style={{ position: 'absolute', top: '50%', left: 0, width: 10 }}
            />
          </span>
        )}

        {/* Category dot or chevron */}
        <span className="inline-flex w-5 shrink-0 items-center justify-center">
          {hasChildren ? (
            isCollapsed ? (
              <ChevronRight className="size-3.5" style={{ color: categorySvgColors[category] }} />
            ) : (
              <ChevronDown className="size-3.5" style={{ color: categorySvgColors[category] }} />
            )
          ) : (
            <span className={cn('inline-block size-1.5 rounded-full', categoryDotColors[category])} />
          )}
        </span>

        {/* Span name */}
        <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={node.entry.name}>
          {node.entry.name}
        </span>

        {/* Latency */}
        {displaySettings.showLatency ? (
          <span className="ml-2 shrink-0 font-mono text-muted-foreground">{formatDuration(node.entry.duration)}</span>
        ) : undefined}

        {/* Self Time */}
        {displaySettings.showSelfTime && hasChildren && node.selfTime < node.entry.duration * 0.95 ? (
          <span className="ml-1 shrink-0 font-mono text-muted-foreground/50" title="Self time">
            ({formatDuration(node.selfTime)})
          </span>
        ) : undefined}
      </div>

      {/* Attributes */}
      {displaySettings.showAttributes ? (
        <div className="flex items-center pb-0.5 text-xs">
          {Array.from({ length: node.depth }, (_, i) => (
            <span key={String(i)} className="w-5 shrink-0" />
          ))}
          <span className="w-5 shrink-0" />
          <SpanAttributeBadges entry={node.entry} />
        </div>
      ) : undefined}

      {/* Children */}
      {hasChildren && !isCollapsed
        ? node.children.map((child, index) => (
            <StandardSpanNode
              key={`${child.entry.name}-${String(index)}`}
              node={child}
              collapsedSet={collapsedSet}
              displaySettings={displaySettings}
              isLast={index === node.children.length - 1}
              ancestorIsLast={[...ancestorIsLast, isLast]}
              onToggle={onToggle}
            />
          ))
        : undefined}
    </>
  );
}

function StandardTreeView({
  spanTree,
  collapsedSet,
  onToggle,
  displaySettings,
}: {
  readonly spanTree: SpanNode[];
  readonly collapsedSet: Set<string>;
  readonly onToggle: (spanId: string) => void;
  readonly displaySettings: DisplaySettings;
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {spanTree.map((node, index) => (
        <StandardSpanNode
          key={`${node.entry.name}-${String(index)}`}
          node={node}
          collapsedSet={collapsedSet}
          displaySettings={displaySettings}
          isLast={index === spanTree.length - 1}
          ancestorIsLast={[]}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Waterfall SVG View
// ---------------------------------------------------------------------------

const waterfallRowHeight = 28;
const waterfallBarHeight = 14;
const waterfallNameOffset = -3;
const waterfallLeftPadding = 8;

function generateTicks(durationMs: number, availableWidth: number): number[] {
  if (durationMs <= 0) {
    return [0];
  }

  const targetTickCount = Math.max(2, Math.min(6, Math.floor(availableWidth / 80)));
  const rawInterval = durationMs / targetTickCount;

  const magnitudes = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000] as const;
  let interval = 1;
  for (const m of magnitudes) {
    if (m >= rawInterval) {
      interval = m;
      break;
    }
  }

  const ticks: number[] = [];
  for (let t = 0; t <= durationMs + interval * 0.1; t += interval) {
    ticks.push(t);
  }

  return ticks;
}

function WaterfallView({
  spanTree,
  renderStart,
  renderDuration,
  collapsedSet,
  onToggle,
  displaySettings,
}: {
  readonly spanTree: SpanNode[];
  readonly renderStart: number;
  readonly renderDuration: number;
  readonly collapsedSet: Set<string>;
  readonly onToggle: (spanId: string) => void;
  readonly displaySettings: DisplaySettings;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const flatNodes = useMemo(() => flattenSpanTree(spanTree, collapsedSet), [spanTree, collapsedSet]);

  const svgHeight = flatNodes.length * waterfallRowHeight + waterfallRowHeight;
  const svgWidth = '100%';

  return (
    <div ref={containerRef} className="flex flex-col overflow-x-auto overflow-y-auto">
      <svg width={svgWidth} height={svgHeight} className="min-w-full" style={{ minHeight: svgHeight }}>
        <WaterfallAxis renderDuration={renderDuration} />
        <WaterfallGrid renderDuration={renderDuration} height={svgHeight} />

        {flatNodes.map((node, index) => {
          const spanId = getSpanId(node.entry);
          const hasChildren = node.children.length > 0;
          const isCollapsed = spanId ? collapsedSet.has(spanId) : false;
          const y = (index + 1) * waterfallRowHeight;
          const category = getSpanCategory(node.entry.name);

          return (
            <WaterfallRow
              key={spanId ?? `${node.entry.name}-${String(index)}`}
              node={node}
              y={y}
              renderStart={renderStart}
              renderDuration={renderDuration}
              category={category}
              hasChildren={hasChildren}
              isCollapsed={isCollapsed}
              spanId={spanId}
              displaySettings={displaySettings}
              onToggle={onToggle}
            />
          );
        })}
      </svg>
    </div>
  );
}

function WaterfallAxis({ renderDuration }: { readonly renderDuration: number }): React.JSX.Element {
  const ticks = useMemo(() => generateTicks(renderDuration, 400), [renderDuration]);

  return (
    <g className="text-[10px]">
      {ticks.map((tick) => {
        const xPercent = renderDuration > 0 ? (tick / renderDuration) * 100 : 0;
        return (
          <text
            key={tick}
            x={`${xPercent}%`}
            y={14}
            textAnchor="middle"
            className="fill-muted-foreground"
            style={{ fontSize: 10 }}
          >
            {formatDuration(tick)}
          </text>
        );
      })}
      <line
        x1="0"
        y1={waterfallRowHeight - 2}
        x2="100%"
        y2={waterfallRowHeight - 2}
        className="stroke-border"
        strokeWidth={1}
      />
    </g>
  );
}

function WaterfallGrid({
  renderDuration,
  height,
}: {
  readonly renderDuration: number;
  readonly height: number;
}): React.JSX.Element {
  const ticks = useMemo(() => generateTicks(renderDuration, 400), [renderDuration]);

  return (
    <g>
      {ticks.map((tick) => {
        const xPercent = renderDuration > 0 ? (tick / renderDuration) * 100 : 0;
        return (
          <line
            key={tick}
            x1={`${xPercent}%`}
            y1={waterfallRowHeight}
            x2={`${xPercent}%`}
            y2={height}
            className="stroke-border/30"
            strokeWidth={1}
            strokeDasharray="2,4"
          />
        );
      })}
    </g>
  );
}

function WaterfallRow({
  node,
  y,
  renderStart,
  renderDuration,
  category,
  hasChildren,
  isCollapsed,
  spanId,
  onToggle,
  displaySettings,
}: {
  readonly node: SpanNode;
  readonly y: number;
  readonly renderStart: number;
  readonly renderDuration: number;
  readonly category: SpanCategory;
  readonly hasChildren: boolean;
  readonly isCollapsed: boolean;
  readonly spanId: string | undefined;
  readonly onToggle: (spanId: string) => void;
  readonly displaySettings: DisplaySettings;
}): React.JSX.Element {
  const leftPercent = renderDuration > 0 ? ((node.entry.startTime - renderStart) / renderDuration) * 100 : 0;
  const widthPercent = renderDuration > 0 ? (node.entry.duration / renderDuration) * 100 : 0;
  const barX = `${Math.max(0, leftPercent)}%`;
  const barW = `${Math.max(0.5, Math.min(100 - Math.max(0, leftPercent), widthPercent))}%`;
  const barY = y + (waterfallRowHeight - waterfallBarHeight) / 2;

  const labelParts = [node.entry.name];
  if (displaySettings.showLatency) {
    labelParts.push(formatDuration(node.entry.duration));
  }

  const label = labelParts.join('  ');
  const fillColor = categorySvgColors[category];
  const depthPad = node.depth * 12 + waterfallLeftPadding;

  return (
    <g className="group/row">
      {/* Hover background */}
      <rect
        x={0}
        y={y}
        width="100%"
        height={waterfallRowHeight}
        className="fill-transparent group-hover/row:fill-muted/30"
        style={hasChildren ? { cursor: 'pointer' } : undefined}
        onClick={
          hasChildren && spanId
            ? () => {
                onToggle(spanId);
              }
            : undefined
        }
      />

      {/* Bar */}
      <rect x={barX} y={barY} width={barW} height={waterfallBarHeight} rx={3} fill={fillColor} opacity={0.35} />
      <rect
        x={barX}
        y={barY}
        width={barW}
        height={waterfallBarHeight}
        rx={3}
        fill="none"
        stroke={fillColor}
        strokeWidth={1}
        opacity={0.6}
      />

      {/* Label above bar */}
      <text
        x={depthPad}
        y={y + waterfallNameOffset + (waterfallRowHeight - waterfallBarHeight) / 2}
        className="fill-foreground"
        style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}
      >
        {label}
      </text>

      {/* Collapse chevron */}
      {hasChildren && spanId ? (
        <g
          style={{ cursor: 'pointer' }}
          onClick={() => {
            onToggle(spanId);
          }}
        >
          <text
            x="97%"
            y={y + waterfallRowHeight / 2 + 4}
            textAnchor="end"
            className="fill-muted-foreground"
            style={{ fontSize: 10 }}
          >
            {isCollapsed ? '▸' : '▾'}
          </text>
        </g>
      ) : undefined}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Trace Toolbar
// ---------------------------------------------------------------------------

function TraceToolbar({
  viewMode,
  displaySettings,
  filters,
  isAllCollapsed,
  onViewModeChange,
  onDisplaySettingsChange,
  onFiltersChange,
  onToggleCollapseAll,
}: {
  readonly viewMode: ViewMode;
  readonly displaySettings: DisplaySettings;
  readonly filters: FilterCondition[];
  readonly isAllCollapsed: boolean;
  readonly onViewModeChange: (mode: ViewMode) => void;
  readonly onDisplaySettingsChange: (settings: DisplaySettings) => void;
  readonly onFiltersChange: (filters: FilterCondition[]) => void;
  readonly onToggleCollapseAll: () => void;
}): React.JSX.Element {
  const hasActiveFilters = filters.some((f) => f.value !== '');

  return (
    <div className="flex items-center justify-between gap-1">
      <div className="flex items-center gap-1">
        {/* Filter */}
        <Popover>
          <PopoverTrigger asChild>
            <PaneButton tooltip="Filter spans" className="relative">
              <ListFilter className="size-3.5" />
              {hasActiveFilters ? (
                <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" />
              ) : undefined}
            </PaneButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto min-w-80 p-3">
            <TraceConditionPicker conditions={filters} onChange={onFiltersChange} />
          </PopoverContent>
        </Popover>

        {/* View toggle */}
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={viewMode}
          onValueChange={(value) => {
            if (value) {
              onViewModeChange(value as ViewMode);
            }
          }}
        >
          <ToggleGroupItem value="standard" className="h-6 px-2 text-[11px]">
            Standard
          </ToggleGroupItem>
          <ToggleGroupItem value="waterfall" className="h-6 px-2 text-[11px]">
            Waterfall
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex items-center gap-0.5">
        {/* Settings */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PaneButton tooltip="Display settings">
              <Settings2 className="size-3.5" />
            </PaneButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuCheckboxItem
              checked={displaySettings.showLatency}
              onSelect={(event) => {
                event.preventDefault();
              }}
              onCheckedChange={(checked) => {
                onDisplaySettingsChange({ ...displaySettings, showLatency: Boolean(checked) });
              }}
            >
              Show Latency
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={displaySettings.showSelfTime}
              onSelect={(event) => {
                event.preventDefault();
              }}
              onCheckedChange={(checked) => {
                onDisplaySettingsChange({ ...displaySettings, showSelfTime: Boolean(checked) });
              }}
            >
              Show Self Time
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={displaySettings.showAttributes}
              onSelect={(event) => {
                event.preventDefault();
              }}
              onCheckedChange={(checked) => {
                onDisplaySettingsChange({ ...displaySettings, showAttributes: Boolean(checked) });
              }}
            >
              Show Attributes
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Visibility</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={displaySettings.visibility}
              onValueChange={(value) => {
                onDisplaySettingsChange({ ...displaySettings, visibility: value as 'all' | 'relevant' });
              }}
            >
              <DropdownMenuRadioItem
                value="all"
                onSelect={(event) => {
                  event.preventDefault();
                }}
              >
                All
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                value="relevant"
                onSelect={(event) => {
                  event.preventDefault();
                }}
              >
                Most relevant
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Collapse/Expand All */}
        <PaneButton tooltip={isAllCollapsed ? 'Expand all' : 'Collapse all'} onClick={onToggleCollapseAll}>
          {isAllCollapsed ? <ChevronsUpDown className="size-3.5" /> : <ChevronsDownUp className="size-3.5" />}
        </PaneButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CompilationUnitTiming (orchestrator)
// ---------------------------------------------------------------------------

function collectAllSpanIds(roots: SpanNode[]): Set<string> {
  const ids = new Set<string>();
  function walk(node: SpanNode): void {
    const spanId = getSpanId(node.entry);
    if (spanId && node.children.length > 0) {
      ids.add(spanId);
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  for (const root of roots) {
    walk(root);
  }

  return ids;
}

function CompilationUnitTiming({ cadRef }: { readonly cadRef: ActorRefFrom<typeof cadMachine> }): React.JSX.Element {
  const renderPhase = useSelector(cadRef, (state) => state.context.renderPhase);
  const pipelineData = useSelector(cadRef, selectPipelineData);
  const telemetryEntries = useSelector(cadRef, (state) => state.context.telemetryEntries);

  const [collapsedSpans, setCollapsedSpans] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>('standard');
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings>(defaultDisplaySettings);

  const { phaseDurations, totalDuration } = pipelineData;
  const maxDuration = Math.max(...phaseDurations.values(), 1);
  const visiblePhases = phaseOrder.filter((p) => phaseDurations.has(p));

  const spanTree = useMemo(() => {
    if (telemetryEntries.length === 0) {
      return [];
    }

    return buildSpanTree(telemetryEntries);
  }, [telemetryEntries]);

  const processedTree = useMemo(() => {
    let tree = spanTree;
    tree = filterSpanTree(tree, filters);
    tree = applyVisibility(tree, displaySettings.visibility);
    return tree;
  }, [spanTree, filters, displaySettings.visibility]);

  const { renderStart, renderDuration } = useMemo(() => {
    if (telemetryEntries.length === 0) {
      return { renderStart: 0, renderDuration: 0 };
    }

    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const entry of telemetryEntries) {
      if (entry.startTime < minStart) {
        minStart = entry.startTime;
      }

      const end = entry.startTime + entry.duration;
      if (end > maxEnd) {
        maxEnd = end;
      }
    }

    return { renderStart: minStart, renderDuration: maxEnd - minStart };
  }, [telemetryEntries]);

  const toggleSpan = useCallback((spanId: string) => {
    setCollapsedSpans((previous) => {
      const next = new Set(previous);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }

      return next;
    });
  }, []);

  const isAllCollapsed = useMemo(() => {
    const allIds = collectAllSpanIds(processedTree);
    if (allIds.size === 0) {
      return false;
    }

    for (const id of allIds) {
      if (!collapsedSpans.has(id)) {
        return false;
      }
    }

    return true;
  }, [processedTree, collapsedSpans]);

  const toggleCollapseAll = useCallback(() => {
    if (isAllCollapsed) {
      setCollapsedSpans(new Set());
    } else {
      setCollapsedSpans(collectAllSpanIds(processedTree));
    }
  }, [isAllCollapsed, processedTree]);

  return (
    <div className="flex flex-col gap-2 p-2">
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
              duration={phaseDurations.get(phase) ?? 0}
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

      {spanTree.length > 0 && (
        <div className="mt-1 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Telemetry</span>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block size-1.5 rounded-full bg-primary" />
                framework
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block size-1.5 rounded-full bg-success" />
                kernel
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block size-1.5 rounded-full bg-warning" />
                middleware
              </span>
            </div>
          </div>

          <TraceToolbar
            viewMode={viewMode}
            displaySettings={displaySettings}
            filters={filters}
            isAllCollapsed={isAllCollapsed}
            onViewModeChange={setViewMode}
            onDisplaySettingsChange={setDisplaySettings}
            onFiltersChange={setFilters}
            onToggleCollapseAll={toggleCollapseAll}
          />

          {viewMode === 'standard' ? (
            <StandardTreeView
              spanTree={processedTree}
              collapsedSet={collapsedSpans}
              displaySettings={displaySettings}
              onToggle={toggleSpan}
            />
          ) : (
            <WaterfallView
              spanTree={processedTree}
              renderStart={renderStart}
              renderDuration={renderDuration}
              collapsedSet={collapsedSpans}
              displaySettings={displaySettings}
              onToggle={toggleSpan}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CompilationUnitSummary({ cadRef }: { readonly cadRef: ActorRefFrom<typeof cadMachine> }): React.JSX.Element {
  const renderPhase = useSelector(cadRef, (state) => state.context.renderPhase);
  const { totalDuration } = useSelector(cadRef, selectPipelineData);

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
      <CollapsibleTrigger className="group/collapsible flex h-8 w-full items-center justify-between px-2 py-1.5 transition-colors hover:bg-muted/50">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-in-out group-data-[state=open]/collapsible:rotate-90" />
          <span className="truncate text-xs font-medium text-foreground">{entryFile}</span>
        </div>
        <CompilationUnitSummary cadRef={cadRef} />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-0 py-0">
        <CompilationUnitTiming cadRef={cadRef} />
        <div className="mx-2 border-t border-border/20" />
        <CompilationUnitLogs entryFile={entryFile} />
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

export const ChatKernel = memo(function ({
  isExpanded,
  setIsExpanded,
  className,
}: {
  readonly isExpanded: boolean;
  readonly setIsExpanded: (isExpanded: boolean | ((previous: boolean) => boolean)) => void;
  readonly className?: string;
}): React.JSX.Element {
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

        <FloatingPanelContentBody className="flex-1 overflow-y-auto p-0">
          <KernelCompilationUnits />
        </FloatingPanelContentBody>
      </FloatingPanelContent>
    </FloatingPanel>
  );
});
