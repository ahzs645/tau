type RequirementIndicatorProps = {
  readonly passedCount: number;
  readonly failedCount: number;
};

export function RequirementIndicator({ passedCount, failedCount }: RequirementIndicatorProps): React.JSX.Element {
  return (
    <span className="flex items-center gap-1 font-mono text-xs">
      {passedCount > 0 && <span className="text-success">✓{passedCount}</span>}
      {failedCount > 0 && <span className="text-destructive">✗{failedCount}</span>}
    </span>
  );
}
