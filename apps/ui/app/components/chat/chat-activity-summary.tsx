type ChatActivitySummaryProps = {
  /** Verb fragment, e.g. `"Explored"`. Rendered with emphasis. */
  readonly verb: string;
  /** Detail fragment, e.g. `"12 searches, 2 fetches"`. Rendered de-emphasized. */
  readonly detail: string;
};

/**
 * Two-tone summary label shared by {@link ChatActivitySection} (outer fold)
 * and `ChatActivityGroup` (inner fold).
 *
 * Keeps the verb/detail typography consistent across both fold levels so the
 * section header and the collapsed group header read as the same visual
 * vocabulary (e.g. `Explored 12 searches, 2 fetches`, verb emphasized).
 */
export function ChatActivitySummary({ verb, detail }: ChatActivitySummaryProps): React.JSX.Element {
  return (
    <>
      {verb !== '' && <span className='shrink-0 font-medium text-foreground/60'>{verb}</span>}
      {detail !== '' && <span className='min-w-0 truncate font-normal text-foreground/50'>{detail}</span>}
    </>
  );
}
