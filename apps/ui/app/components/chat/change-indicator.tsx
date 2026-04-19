type ChangeIndicatorProps = {
  readonly linesAdded: number;
  readonly linesRemoved: number;
};

export function ChangeIndicator({ linesAdded, linesRemoved }: ChangeIndicatorProps): React.JSX.Element {
  return (
    <span className='flex items-center gap-1 font-mono text-xs'>
      {linesAdded > 0 && <span className='text-success'>+{linesAdded}</span>}
      {linesRemoved > 0 && <span className='text-destructive'>-{linesRemoved}</span>}
    </span>
  );
}
