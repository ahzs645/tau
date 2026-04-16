import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ActorRefFrom } from 'xstate';
import type { FileParameterEntry } from '@taucad/types';
import type { cadMachine } from '#machines/cad.machine.js';

vi.mock('@xstate/react', () => ({
  useSelector: (actor: { getSnapshot: () => unknown } | undefined, selector: (state: unknown) => unknown) => {
    if (!actor) {
      return selector(undefined);
    }
    return selector(actor.getSnapshot());
  },
}));

const mockCadRef = {
  getSnapshot: vi.fn(() => ({
    context: {
      defaultParameters: { width: 10, height: 20 },
      jsonSchema: {
        type: 'object',
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
    },
  })),
} as unknown as ActorRefFrom<typeof cadMachine>;

const mockCadRef2 = {
  getSnapshot: vi.fn(() => ({
    context: {
      defaultParameters: { radius: 5 },
      jsonSchema: {
        type: 'object',
        properties: {
          radius: { type: 'number' },
        },
      },
    },
  })),
} as unknown as ActorRefFrom<typeof cadMachine>;

let mockCompilationUnits = new Map<string, ActorRefFrom<typeof cadMachine>>();
const mockMainEntryFile = 'main.ts';
const mockSetParameters = vi.fn();
const mockSetCompilationUnitParameters = vi.fn();
const mockSwitchParameterGroup = vi.fn();
let mockParameterEntries = new Map<string, FileParameterEntry>();

vi.mock('#hooks/use-project.js', () => ({
  useProject: () => ({
    projectRef: {
      getSnapshot: vi.fn(() => ({ context: { project: null } })),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      on: vi.fn(() => ({ unsubscribe: vi.fn() })),
    },
    compilationUnits: mockCompilationUnits,
    mainEntryFile: mockMainEntryFile,
    setParameters: mockSetParameters,
    setCompilationUnitParameters: mockSetCompilationUnitParameters,
    switchParameterGroup: mockSwitchParameterGroup,
    createParameterGroup: vi.fn(),
    deleteParameterGroup: vi.fn(),
    renameParameterGroup: vi.fn(),
    parameterEntries: mockParameterEntries,
  }),
  useMainGraphics: () => ({
    getSnapshot: vi.fn(() => ({
      context: { units: { length: { symbol: 'mm', factor: 1 } } },
    })),
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    on: vi.fn(() => ({ unsubscribe: vi.fn() })),
  }),
}));

vi.mock('dockview-react', () => ({
  PaneviewReact: ({
    onReady,
    components,
    headerComponents,
  }: {
    onReady: (event: { api: { addPanel: (options: Record<string, unknown>) => void } }) => void;
    components: Record<string, React.ComponentType<{ params: Record<string, unknown> }>>;
    headerComponents?: Record<string, React.ComponentType<{ api: unknown; params: Record<string, unknown> }>>;
  }) => {
    type MockPanel = {
      id: string;
      title: string;
      component: string;
      headerComponent?: string;
      isExpanded: boolean;
      params: Record<string, unknown> & { entryFile: string };
      api: { updateParameters: (newParams: Record<string, unknown>) => void };
    };
    const panels: MockPanel[] = [];
    const api = {
      panels,
      addPanel: (options: Record<string, unknown>) => {
        const panel = options as unknown as Omit<MockPanel, 'api'>;
        panels.push({
          ...panel,
          api: {
            updateParameters: (newParams: Record<string, unknown>) => {
              Object.assign(panel.params, newParams);
            },
          },
        });
      },
    };
    onReady({ api });
    const mockPanelApi = {
      isExpanded: true,
      onDidExpansionChange: () => ({ dispose: () => {} }),
      setExpanded: () => {},
      setSize: () => {},
      updateParameters: () => {},
    };
    return (
      <div data-testid='paneview'>
        {panels.map((p) => {
          const Component = components[p.component];
          const HeaderComponent = p.headerComponent && headerComponents?.[p.headerComponent];
          return (
            <div key={p.id} data-testid={`param-pane-${p.id}`} data-expanded={p.isExpanded}>
              {HeaderComponent ? <HeaderComponent api={mockPanelApi} params={p.params} /> : p.params.entryFile}
              {Component ? <Component params={p.params} /> : null}
            </div>
          );
        })}
      </div>
    );
  },
}));

vi.mock('#components/geometry/parameters/parameters.js', () => ({
  Parameters: ({
    parameters,
    onParametersChange,
  }: {
    parameters: Record<string, unknown>;
    onParametersChange: (params: Record<string, unknown>) => void;
  }) => (
    <div data-testid='parameters-component' data-params={JSON.stringify(parameters)}>
      <button
        type='button'
        data-testid='change-params'
        onClick={() => {
          onParametersChange({ width: 42 });
        }}
      >
        Change
      </button>
    </div>
  ),
}));

vi.mock('#hooks/use-keyboard.js', () => ({
  useKeybinding: () => ({ formattedKeyCombination: 'Ctrl+X' }),
}));

vi.mock('#components/ui/floating-panel.js', () => ({
  FloatingPanel: ({ children }: { children: React.ReactNode }) => <div data-testid='floating-panel'>{children}</div>,
  FloatingPanelContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FloatingPanelContentBody: ({ children }: { children: React.ReactNode }) => (
    <div data-testid='panel-body'>{children}</div>
  ),
  FloatingPanelContentHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FloatingPanelContentHeaderActions: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FloatingPanelContentTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FloatingPanelClose: () => <button type='button'>Close</button>,
  FloatingPanelMenuButton: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
  }) => (
    <button type='button' aria-label={rest['aria-label']} onClick={onClick}>
      {children}
    </button>
  ),
  FloatingPanelButtonGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FloatingPanelTrigger: ({ onClick }: { onClick: () => void }) => (
    <button type='button' data-testid='params-trigger' onClick={onClick}>
      Trigger
    </button>
  ),
}));

vi.mock('#components/ui/key-shortcut.js', () => ({
  KeyShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@taucad/utils/schema', () => ({
  hasJsonSchemaObjectProperties: (schema: unknown) =>
    Boolean(schema && typeof schema === 'object' && 'properties' in schema),
}));

vi.mock('#components/ui/tooltip.js', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('#components/ui/combobox-responsive.js', () => ({
  ComboBoxResponsive: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('#routes/projects_.$id/use-chat-interface-state.js', () => ({
  usePaneviewPersistence: () => ({
    savedState: {},
    connectApi: vi.fn(),
  }),
  getInitialPanelOptions: (
    _saved: Record<string, unknown>,
    _panelId: string,
    defaults: { isExpanded: boolean; size?: number },
  ) => defaults,
}));

describe('ChatParameters', () => {
  beforeEach(() => {
    mockCompilationUnits = new Map<string, ActorRefFrom<typeof cadMachine>>();
    mockSetParameters.mockClear();
    mockSetCompilationUnitParameters.mockClear();
    mockSwitchParameterGroup.mockClear();
    mockParameterEntries = new Map<string, FileParameterEntry>([
      [
        'main.ts',
        {
          activeGroup: 'default',
          groups: { default: { values: { width: 15 } } },
        },
      ],
    ]);
  });

  it('should render single CU inside PaneviewReact', async () => {
    mockCompilationUnits.set('main.ts', mockCadRef);

    const { ChatParameters } = await import('./chat-parameters.js');
    render(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    expect(screen.getByTestId('paneview')).toBeInTheDocument();
    expect(screen.getByTestId('param-pane-main.ts')).toBeInTheDocument();
  });

  it('renders PaneviewReact for multiple CUs', async () => {
    mockCompilationUnits.set('main.ts', mockCadRef);
    mockCompilationUnits.set('helper.ts', mockCadRef2);

    const { ChatParameters } = await import('./chat-parameters.js');
    render(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    expect(screen.getByTestId('paneview')).toBeInTheDocument();
  });

  it('places mainFile pane first', async () => {
    mockCompilationUnits.set('helper.ts', mockCadRef2);
    mockCompilationUnits.set('main.ts', mockCadRef);

    const { ChatParameters } = await import('./chat-parameters.js');
    render(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    const panes = screen.getAllByTestId(/^param-pane-/);
    expect(panes[0]!.dataset['testid']).toBe('param-pane-main.ts');
  });

  it('expands mainFile pane by default', async () => {
    mockCompilationUnits.set('helper.ts', mockCadRef2);
    mockCompilationUnits.set('main.ts', mockCadRef);

    const { ChatParameters } = await import('./chat-parameters.js');
    render(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    const mainPane = screen.getByTestId('param-pane-main.ts');
    expect(mainPane.dataset['expanded']).toBe('true');

    const helperPane = screen.getByTestId('param-pane-helper.ts');
    expect(helperPane.dataset['expanded']).toBe('false');
  });

  it('reads parameter values from parameterEntries active group', async () => {
    mockCompilationUnits.set('main.ts', mockCadRef);

    const { ChatParameters } = await import('./chat-parameters.js');
    render(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    const paramsComponent = screen.getByTestId('parameters-component');
    const params: unknown = JSON.parse(paramsComponent.dataset['params']!);
    expect(params).toEqual({ width: 15 });
  });

  it('calls setCompilationUnitParameters when parameters change', async () => {
    mockCompilationUnits.set('main.ts', mockCadRef);

    const { ChatParameters } = await import('./chat-parameters.js');
    render(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    fireEvent.click(screen.getByTestId('change-params'));
    expect(mockSetCompilationUnitParameters).toHaveBeenCalledWith('main.ts', { width: 42 });
  });

  it('shows empty message when no compilation units', async () => {
    const { ChatParameters } = await import('./chat-parameters.js');
    render(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    expect(screen.getByText('No compilation units.')).toBeInTheDocument();
  });

  it('returns empty params when entry is missing', async () => {
    mockParameterEntries = new Map();
    mockCompilationUnits.set('main.ts', mockCadRef);

    const { ChatParameters } = await import('./chat-parameters.js');
    render(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    const paramsComponent = screen.getByTestId('parameters-component');
    const params: unknown = JSON.parse(paramsComponent.dataset['params']!);
    expect(params).toEqual({});
  });
});

describe('ParameterGroupSelector', () => {
  beforeEach(() => {
    mockCompilationUnits = new Map<string, ActorRefFrom<typeof cadMachine>>();
    mockSwitchParameterGroup.mockClear();
    mockParameterEntries = new Map<string, FileParameterEntry>([
      [
        'main.ts',
        {
          activeGroup: 'default',
          groups: {
            default: { values: {} },
            preset1: { values: { width: 50 } },
          },
        },
      ],
    ]);
  });

  it('renders group selector with multiple groups in multi-CU paneview header', async () => {
    mockCompilationUnits.set('main.ts', mockCadRef);
    mockCompilationUnits.set('helper.ts', mockCadRef2);
    mockParameterEntries = new Map<string, FileParameterEntry>([
      [
        'main.ts',
        {
          activeGroup: 'default',
          groups: {
            default: { values: {} },
            preset1: { values: { width: 50 } },
          },
        },
      ],
      [
        'helper.ts',
        {
          activeGroup: 'default',
          groups: { default: { values: {} } },
        },
      ],
    ]);

    const { ChatParameters } = await import('./chat-parameters.js');
    render(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    expect(screen.getByTestId('paneview')).toBeInTheDocument();
  });
});

describe('ParameterGroupManager — active group name', () => {
  beforeEach(() => {
    mockCompilationUnits = new Map<string, ActorRefFrom<typeof cadMachine>>();
    mockSwitchParameterGroup.mockClear();
  });

  it('displays the active group name dynamically in the header', async () => {
    mockCompilationUnits.set('main.ts', mockCadRef);
    mockParameterEntries = new Map<string, FileParameterEntry>([
      [
        'main.ts',
        {
          activeGroup: 'my-custom-group',
          groups: {
            default: { values: {} },
            'my-custom-group': { values: { width: 99 } },
          },
        },
      ],
    ]);

    const { ChatParameters } = await import('./chat-parameters.js');
    render(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    expect(screen.getByText('my-custom-group')).toBeInTheDocument();
  });

  it('updates the displayed group name when activeGroup changes', async () => {
    mockCompilationUnits.set('main.ts', mockCadRef);
    mockParameterEntries = new Map<string, FileParameterEntry>([
      [
        'main.ts',
        {
          activeGroup: 'default',
          groups: {
            default: { values: {} },
            alternate: { values: { width: 50 } },
          },
        },
      ],
    ]);

    const { ChatParameters } = await import('./chat-parameters.js');
    const { rerender } = render(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.queryByText('alternate')).not.toBeInTheDocument();

    mockParameterEntries = new Map<string, FileParameterEntry>([
      [
        'main.ts',
        {
          activeGroup: 'alternate',
          groups: {
            default: { values: {} },
            alternate: { values: { width: 50 } },
          },
        },
      ],
    ]);

    rerender(<ChatParameters isExpanded setIsExpanded={vi.fn()} />);

    expect(screen.getByText('alternate')).toBeInTheDocument();
  });
});

describe('ChatParametersTrigger', () => {
  it('renders trigger button', async () => {
    const { ChatParametersTrigger } = await import('./chat-parameters.js');
    const onToggle = vi.fn();
    render(<ChatParametersTrigger isOpen={false} onToggle={onToggle} />);

    expect(screen.getByTestId('params-trigger')).toBeInTheDocument();
  });
});
