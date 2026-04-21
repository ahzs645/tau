// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/naming-convention -- file-path keys (e.g. 'lib/bracket.scad') can't be camelCase */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ToolInvocation } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { ChatMessageToolTestModel } from '#routes/projects_.$id/chat-message-tool-test-model.js';

vi.mock('#hooks/use-chat.js', () => ({
  useChatSelector<T>(selector: (state: { status: 'streaming' | 'idle' }) => T): T {
    return selector({ status: 'idle' });
  },
}));

vi.mock('#components/chat/chat-tool-card.js', () => ({
  ChatToolCard({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div data-testid='chat-tool-card'>{children}</div>;
  },
  ChatToolCardHeader({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div>{children}</div>;
  },
  ChatToolCardIcon({ tone }: { readonly tone?: string }): React.JSX.Element {
    return <span data-testid='chat-tool-card-icon' data-tone={tone ?? ''} />;
  },
  ChatToolCardTitle({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div>{children}</div>;
  },
  ChatToolCardContent({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div>{children}</div>;
  },
}));

vi.mock('#components/chat/requirement-indicator.js', () => ({
  RequirementIndicator({
    failedCount,
    passedCount,
  }: {
    readonly failedCount: number;
    readonly passedCount: number;
  }): React.JSX.Element {
    return (
      <span data-testid='requirement-indicator' data-failed={failedCount} data-passed={passedCount}>
        {passedCount}/{passedCount + failedCount}
      </span>
    );
  },
}));

vi.mock('#components/chat/chat-tool-text.js', () => ({
  ChatToolAction({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <span>{children}</span>;
  },
  ChatToolDescription({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <span>{children}</span>;
  },
}));

vi.mock('#components/chat/chat-tool-error.js', () => ({
  ChatToolError({ errorText }: { readonly errorText: string }): React.JSX.Element {
    return <div data-testid='chat-tool-error'>{errorText}</div>;
  },
}));

vi.mock('#components/files/file-link.js', () => ({
  FileLink({
    children,
    path,
    className,
  }: {
    readonly children: React.ReactNode;
    readonly path: string;
    readonly className?: string;
  }): React.JSX.Element {
    return (
      <a data-testid='file-link' data-path={path} href={`#${path}`} className={className}>
        {children}
      </a>
    );
  },
}));

vi.mock('#components/files/viewer-link.js', () => ({
  ViewerLink({
    children,
    path,
    className,
  }: {
    readonly children: React.ReactNode;
    readonly path: string;
    readonly className?: string;
  }): React.JSX.Element {
    return (
      <a data-testid='viewer-link' data-path={path} href={`#${path}`} className={className}>
        {children}
      </a>
    );
  },
}));

vi.mock('#components/ui/tooltip.js', () => ({
  Tooltip({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div data-testid='tooltip'>{children}</div>;
  },
  TooltipTrigger({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div data-testid='tooltip-trigger'>{children}</div>;
  },
  TooltipContent({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <span data-testid='tooltip-content'>{children}</span>;
  },
}));

type TestModelInvocation = ToolInvocation<typeof toolName.testModel>;
type TestModelOutputAvailable = Extract<TestModelInvocation, { state: 'output-available' }>;

const buildPart = (output: TestModelOutputAvailable['output']): TestModelOutputAvailable => ({
  type: 'tool-test_model',
  toolCallId: 'tc_1',
  state: 'output-available',
  input: {},
  output,
});

afterEach(() => {
  cleanup();
});

describe('ChatMessageToolTestModel — multi-file rendering', () => {
  it('should render a per-file section for every file in the failures map', () => {
    const part = buildPart({
      passed: 1,
      total: 4,
      passes: [{ id: 'p1', requirement: 'main pass', targetFile: 'main.scad' }],
      failures: [
        {
          id: 'f1',
          requirement: 'main width = 100mm',
          reason: 'Width is 80mm',
          suggestion: 'Increase width',
          targetFile: 'main.scad',
        },
        {
          id: 'f2',
          requirement: 'lib bracket is single solid',
          reason: 'Got 2 components',
          suggestion: 'Union the parts',
          targetFile: 'lib/bracket.scad',
        },
        {
          id: 'f3',
          requirement: 'lib bracket is watertight',
          reason: 'Open boundary',
          suggestion: 'Close the boundary',
          targetFile: 'lib/bracket.scad',
        },
      ],
      geometryArtifactPaths: {
        'main.scad': '.tau/artifacts/tc_1__main.scad.glb',
        'lib/bracket.scad': '.tau/artifacts/tc_1__lib_bracket.scad.glb',
      },
    });

    render(<ChatMessageToolTestModel part={part} />);

    // Both target file paths are rendered as section headings
    expect(screen.getByText('main.scad')).toBeTruthy();
    expect(screen.getByText('lib/bracket.scad')).toBeTruthy();

    // Each requirement appears once
    expect(screen.getByText(/main width = 100mm/)).toBeTruthy();
    expect(screen.getByText(/lib bracket is single solid/)).toBeTruthy();
    expect(screen.getByText(/lib bracket is watertight/)).toBeTruthy();
  });

  it('should render one geometry artifact badge per file, each linking to its own artifact path', () => {
    const part = buildPart({
      passed: 0,
      total: 2,
      passes: [],
      failures: [
        {
          id: 'f1',
          requirement: 'main width = 100mm',
          reason: 'r',
          suggestion: 's',
          targetFile: 'main.scad',
        },
        {
          id: 'f2',
          requirement: 'lib width = 50mm',
          reason: 'r',
          suggestion: 's',
          targetFile: 'lib/bracket.scad',
        },
      ],
      geometryArtifactPaths: {
        'main.scad': '.tau/artifacts/tc_1__main.scad.glb',
        'lib/bracket.scad': '.tau/artifacts/tc_1__lib_bracket.scad.glb',
      },
    });

    render(<ChatMessageToolTestModel part={part} />);

    const links = screen.getAllByTestId('viewer-link');
    const paths = links.map((l) => l.dataset.path);
    expect(paths).toContain('.tau/artifacts/tc_1__main.scad.glb');
    expect(paths).toContain('.tau/artifacts/tc_1__lib_bracket.scad.glb');
  });

  it('should not render a geometry artifact badge for a file missing from geometryArtifactPaths', () => {
    const part = buildPart({
      passed: 0,
      total: 1,
      passes: [],
      failures: [
        {
          id: 'f1',
          requirement: 'main width = 100mm',
          reason: 'r',
          suggestion: 's',
          targetFile: 'main.scad',
        },
        {
          id: 'f2',
          requirement: 'orphan check',
          reason: 'r',
          suggestion: 's',
          targetFile: 'orphan.scad',
        },
      ],
      geometryArtifactPaths: {
        'main.scad': '.tau/artifacts/tc_1__main.scad.glb',
      },
    });

    render(<ChatMessageToolTestModel part={part} />);

    const links = screen.getAllByTestId('viewer-link');
    const artifactPaths = links
      .map((l) => l.dataset.path)
      .filter((p): p is string => typeof p === 'string' && p.startsWith('.tau/artifacts/'));
    expect(artifactPaths).toEqual(['.tau/artifacts/tc_1__main.scad.glb']);
  });

  it('should group passes by targetFile when all tests pass', () => {
    const part = buildPart({
      passed: 3,
      total: 3,
      passes: [
        { id: 'p1', requirement: 'main pass 1', targetFile: 'main.scad' },
        { id: 'p2', requirement: 'main pass 2', targetFile: 'main.scad' },
        { id: 'p3', requirement: 'lib pass 1', targetFile: 'lib/bracket.scad' },
      ],
      failures: [],
      geometryArtifactPaths: {
        'main.scad': '.tau/artifacts/tc_1__main.scad.glb',
        'lib/bracket.scad': '.tau/artifacts/tc_1__lib_bracket.scad.glb',
      },
    });

    render(<ChatMessageToolTestModel part={part} />);

    // Both file headings appear
    expect(screen.getByText('main.scad')).toBeTruthy();
    expect(screen.getByText('lib/bracket.scad')).toBeTruthy();
    expect(screen.getByText(/main pass 1/)).toBeTruthy();
    expect(screen.getByText(/main pass 2/)).toBeTruthy();
    expect(screen.getByText(/lib pass 1/)).toBeTruthy();
  });

  it('should render the success header as "Tested N requirements" without a trailing pass/fail count indicator', () => {
    const part = buildPart({
      passed: 3,
      total: 3,
      passes: [
        { id: 'p1', requirement: 'main pass 1', targetFile: 'main.scad' },
        { id: 'p2', requirement: 'main pass 2', targetFile: 'main.scad' },
        { id: 'p3', requirement: 'lib pass 1', targetFile: 'lib/bracket.scad' },
      ],
      failures: [],
      geometryArtifactPaths: {},
    });

    render(<ChatMessageToolTestModel part={part} />);

    expect(screen.getByText('Tested')).toBeTruthy();
    expect(screen.getByText(/3 requirements/)).toBeTruthy();
    // Per-file indicators inside FileGroupSection remain; only the trailing
    // header-level indicator should be gone, so every indicator must live
    // inside a [data-target-file] file group.
    const indicators = screen.queryAllByTestId('requirement-indicator');
    expect(indicators.length).toBeGreaterThan(0);
    for (const indicator of indicators) {
      expect(indicator.closest('[data-target-file]')).not.toBeNull();
    }
  });

  it('should render the failure header in the same minimal shape as the success header — `Tested N requirements` only, no header-level indicator chip, with the leading icon flipped to the destructive tone so failures are still flagged at a glance', () => {
    const part = buildPart({
      passed: 9,
      total: 10,
      passes: Array.from({ length: 9 }, (_, index) => ({
        id: `p${index + 1}`,
        requirement: `main pass ${index + 1}`,
        targetFile: 'main.scad',
      })),
      failures: [
        {
          id: 'f1',
          requirement: 'main width = 100mm',
          reason: 'Width is 80mm',
          suggestion: 'Increase width',
          targetFile: 'main.scad',
        },
      ],
      geometryArtifactPaths: {},
    });

    render(<ChatMessageToolTestModel part={part} />);

    expect(screen.getByText('Tested')).toBeTruthy();
    expect(screen.getByText(/10 requirements/)).toBeTruthy();
    expect(screen.queryByText(/failed\)/)).toBeNull();

    // No aggregate header indicator: every requirement-indicator must live
    // inside a per-file FileGroupSection (mirrors the success-header
    // invariant). Drops the prior trailing `RequirementIndicator` chip so
    // success and failure share one render path.
    const indicators = screen.queryAllByTestId('requirement-indicator');
    expect(indicators.length).toBeGreaterThan(0);
    for (const indicator of indicators) {
      expect(indicator.closest('[data-target-file]')).not.toBeNull();
    }

    // Leading FlaskConical icon carries the destructive tone whenever there
    // are failures — the "only red icons indicate failure" convention is the
    // single visual cue that distinguishes failure from success now that the
    // header chrome is identical in both branches.
    const icon = screen.getByTestId('chat-tool-card-icon');
    expect(icon.dataset.tone).toBe('destructive');
  });

  it('should NOT apply the destructive icon tone when every requirement passes', () => {
    const part = buildPart({
      passed: 2,
      total: 2,
      passes: [
        { id: 'p1', requirement: 'main pass 1', targetFile: 'main.scad' },
        { id: 'p2', requirement: 'main pass 2', targetFile: 'main.scad' },
      ],
      failures: [],
      geometryArtifactPaths: {},
    });

    render(<ChatMessageToolTestModel part={part} />);

    const icon = screen.getByTestId('chat-tool-card-icon');
    expect(icon.dataset.tone).toBe('');
  });

  it('should singularise the requirement noun when a single requirement passes', () => {
    const part = buildPart({
      passed: 1,
      total: 1,
      passes: [{ id: 'p1', requirement: 'main pass 1', targetFile: 'main.scad' }],
      failures: [],
      geometryArtifactPaths: {},
    });

    render(<ChatMessageToolTestModel part={part} />);

    expect(screen.getByText(/1 requirement(?!s)/)).toBeTruthy();
  });

  it('keeps the FileGroupSection truncation chain intact when targetFile and artifactPath are extremely long (regressing the missing min-w-0 smoking gun)', () => {
    // Pin the per-row truncation chain end-to-end. Tailwind's `truncate` is a
    // no-op when any flex/grid ancestor still has `min-width: auto` (the flex
    // default). Every wrapper in the FileGroupSection header chain must
    // therefore declare `min-w-0`, and the FileLink itself must render the
    // canonical `min-w-0 truncate` className via `asChild`.
    const longTargetFile =
      'apps/ui/app/routes/projects_.$id/very/deeply/nested/folder/structure/with-an-intentionally-long-filename-to-prove-truncation.scad';
    const longArtifactPath =
      '.tau/artifacts/tooluu_01ARC_thisIsAnIntentionallyLongFilenameToProveTruncation__main.scad.glb';
    const part = buildPart({
      passed: 0,
      total: 1,
      passes: [],
      failures: [
        {
          id: 'f1',
          requirement: 'long-path coverage',
          reason: 'r',
          suggestion: 's',
          targetFile: longTargetFile,
        },
      ],
      geometryArtifactPaths: { [longTargetFile]: longArtifactPath },
    });

    const { container } = render(<ChatMessageToolTestModel part={part} />);

    const groupWrapper = container.querySelector(`[data-target-file="${longTargetFile}"]`);
    expect(groupWrapper).toBeTruthy();
    expect(groupWrapper).toHaveClass('min-w-0');

    const headerRow = groupWrapper!.firstElementChild;
    expect(headerRow).toBeTruthy();
    expect(headerRow).toHaveClass('flex');
    expect(headerRow).toHaveClass('min-w-0');

    const leftColumn = headerRow!.firstElementChild;
    expect(leftColumn).toBeTruthy();
    expect(leftColumn).toHaveClass('flex');
    expect(leftColumn).toHaveClass('min-w-0');
    expect(leftColumn).toHaveClass('flex-1');

    const fileLink = within(groupWrapper as HTMLElement).getByTestId('file-link');
    expect(fileLink.className).toContain('min-w-0');
    expect(fileLink.className).toContain('truncate');

    const viewerLink = within(groupWrapper as HTMLElement).getByTestId('viewer-link');
    const chip = viewerLink.firstElementChild;
    expect(chip).toBeTruthy();
    expect(chip).toHaveClass('flex');
    expect(chip).toHaveClass('min-w-0');
    expect(chip).toHaveClass('max-w-full');
    const pathSpan = chip!.querySelector('span');
    expect(pathSpan).toBeTruthy();
    expect(pathSpan).toHaveClass('min-w-0');
    expect(pathSpan).toHaveClass('truncate');

    // Dedupe contract: the GeometryArtifactBadge JSX must NOT render its own
    // <Box /> — the cube lives exclusively inside ViewerLink and is auto-
    // injected via SlotPrimitive.Slottable. ViewerLink is mocked out in this
    // test, so the auto-injection does not run; what we can pin here is the
    // CONSUMER side: the chip should contain only the path span (no leftover
    // icon-shaped elements from the badge JSX). The end-to-end "exactly one
    // cube" contract is pinned against the real ViewerLink in
    // title-row-truncation-contract.test.tsx.
    expect(chip!.children.length).toBe(1);
    expect(chip!.querySelectorAll('svg').length).toBe(0);
  });

  it('should attribute each failure to its own file group (no cross-file leakage)', () => {
    const part = buildPart({
      passed: 0,
      total: 2,
      passes: [],
      failures: [
        {
          id: 'f1',
          requirement: 'main-only check',
          reason: 'r',
          suggestion: 's',
          targetFile: 'main.scad',
        },
        {
          id: 'f2',
          requirement: 'lib-only check',
          reason: 'r',
          suggestion: 's',
          targetFile: 'lib/bracket.scad',
        },
      ],
      geometryArtifactPaths: {},
    });

    const { container } = render(<ChatMessageToolTestModel part={part} />);

    // Locate per-file group sections by data attribute
    const mainSection = container.querySelector('[data-target-file="main.scad"]');
    const libSection = container.querySelector('[data-target-file="lib/bracket.scad"]');
    expect(mainSection).toBeTruthy();
    expect(libSection).toBeTruthy();

    // Main-only check must be inside main section, NOT lib section, and vice versa
    expect(within(mainSection as HTMLElement).queryByText(/main-only check/)).toBeTruthy();
    expect(within(mainSection as HTMLElement).queryByText(/lib-only check/)).toBeNull();
    expect(within(libSection as HTMLElement).queryByText(/lib-only check/)).toBeTruthy();
    expect(within(libSection as HTMLElement).queryByText(/main-only check/)).toBeNull();
  });
});
