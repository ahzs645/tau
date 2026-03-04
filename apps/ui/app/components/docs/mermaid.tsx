import { Suspense, use, useEffect, useId, useMemo, useState } from 'react';
import { Theme, useTheme } from '#hooks/use-theme.js';

const cache = new Map<string, Promise<unknown>>();

async function cachePromise<T>(key: string, setPromise: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) {
    return cached as Promise<T>;
  }

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

const fontFamily = "'Geist Sans', ui-sans-serif, system-ui, sans-serif";

const diagramCssVariables = [
  '--diagram-node',
  '--diagram-node-border',
  '--diagram-node-text',
  '--diagram-cluster',
  '--diagram-cluster-border',
  '--diagram-line',
  '--diagram-text',
  '--diagram-note',
  '--diagram-note-border',
  '--diagram-accent',
] as const;

type DiagramVariable = (typeof diagramCssVariables)[number];
type DiagramColors = Record<DiagramVariable, string>;

/**
 * Resolves CSS custom properties (which may use oklch, var() chains, etc.)
 * to hex strings that Mermaid's themeVariables API requires.
 */
function resolveDiagramColors(): DiagramColors {
  const container = document.createElement('div');
  container.style.display = 'none';

  const probes = diagramCssVariables.map((variable) => {
    const element = document.createElement('span');
    element.style.color = `var(${variable})`;
    container.append(element);
    return element;
  });

  document.body.append(container);

  const result: Record<string, string> = {};
  for (const [index, element] of probes.entries()) {
    const variable = diagramCssVariables[index];
    if (variable) {
      result[variable] = computedColorToHex(getComputedStyle(element).color);
    }
  }

  container.remove();
  return result as DiagramColors;
}

/**
 * Converts any CSS color string (rgb, oklch, hsl, etc.) to a #rrggbb hex string.
 * Uses Canvas 2D which reliably handles all CSS Color Level 4 formats.
 */
function computedColorToHex(color: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) {
    return '#808080';
  }

  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 128, g = 128, b = 128] = context.getImageData(0, 0, 1, 1).data;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function buildThemeVariables(colors: DiagramColors, { isDark }: { isDark: boolean }): Record<string, unknown> {
  const node = colors['--diagram-node'];
  const nodeBorder = colors['--diagram-node-border'];
  const nodeText = colors['--diagram-node-text'];
  const cluster = colors['--diagram-cluster'];
  const clusterBorder = colors['--diagram-cluster-border'];
  const line = colors['--diagram-line'];
  const text = colors['--diagram-text'];
  const note = colors['--diagram-note'];
  const noteBorder = colors['--diagram-note-border'];
  const accent = colors['--diagram-accent'];

  return {
    darkMode: isDark,
    primaryColor: node,
    primaryTextColor: nodeText,
    primaryBorderColor: nodeBorder,
    secondaryColor: note,
    secondaryTextColor: text,
    secondaryBorderColor: noteBorder,
    tertiaryColor: cluster,
    tertiaryTextColor: text,
    tertiaryBorderColor: clusterBorder,
    lineColor: line,
    textColor: text,
    mainBkg: node,
    nodeBkg: node,
    nodeBorder,
    nodeTextColor: nodeText,
    clusterBkg: cluster,
    clusterBorder,
    edgeLabelBackground: cluster,
    titleColor: nodeText,
    actorBkg: node,
    actorBorder: nodeBorder,
    actorTextColor: nodeText,
    actorLineColor: line,
    signalColor: line,
    signalTextColor: text,
    labelBoxBkgColor: cluster,
    labelBoxBorderColor: clusterBorder,
    labelTextColor: text,
    loopTextColor: text,
    activationBorderColor: accent,
    activationBkgColor: node,
    sequenceNumberColor: nodeText,
    noteBkgColor: note,
    noteBorderColor: noteBorder,
    noteTextColor: text,
  };
}

const themeCss = [
  '.node rect, .node circle, .node ellipse, .node polygon { rx: 12px; ry: 12px; }',
  '.cluster rect { rx: 16px; ry: 16px; }',
  'rect.actor { rx: 12px; ry: 12px; }',
  '.nodeLabel { font-weight: 500; }',
  '.cluster-label .nodeLabel { font-weight: 600; font-size: 0.85em; }',
  '.edgeLabel { font-size: 0.85em; font-weight: 500; }',
  '.edgePath .path { stroke-width: 1.5px; }',
  '.messageText { font-size: 13px; font-weight: 500; }',
].join('\n');

function MermaidRenderer({ chart }: { readonly chart: string }): React.JSX.Element {
  const id = useId();
  const { theme } = useTheme();
  const { default: mermaid } = use(cachePromise('mermaid', async () => import('mermaid')));
  const isDark = theme === Theme.DARK;

  const themeVariables = useMemo(() => buildThemeVariables(resolveDiagramColors(), { isDark }), [isDark]);

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    fontFamily,
    theme: 'base',
    themeVariables,
    themeCSS: themeCss, // eslint-disable-line @typescript-eslint/naming-convention -- Mermaid API property name.
    flowchart: { curve: 'basis', padding: 20 },
  });

  const { svg, bindFunctions } = use(
    cachePromise(`${chart}-${theme}`, async () => {
      return mermaid.render(id, chart.replaceAll(String.raw`\n`, '\n'));
    }),
  );

  return (
    <div className='not-prose my-6 overflow-x-auto rounded-xl border border-border/50 bg-muted/30 px-4 py-6'>
      <div
        // oxlint-disable-next-line react/no-danger -- Mermaid returns pre-rendered SVG strings; dangerouslySetInnerHTML is the intended injection method.
        dangerouslySetInnerHTML={{ __html: svg }}
        ref={(container) => {
          if (container) {
            bindFunctions?.(container);
          }
        }}
        className='[&>svg]:mx-auto [&>svg]:block [&>svg]:bg-transparent!'
      />
    </div>
  );
}

/**
 * Renders a Mermaid diagram from chart definition text.
 * Only mounts on the client to avoid SSR hydration issues.
 */
export function Mermaid({ chart }: { readonly chart: string }): React.JSX.Element | undefined {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return undefined;
  }

  return (
    <Suspense>
      <MermaidRenderer chart={chart} />
    </Suspense>
  );
}
