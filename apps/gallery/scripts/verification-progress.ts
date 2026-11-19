type ProgressCase = { readonly project: string; readonly variant: string; readonly error?: string };

/** Preserve completed failure evidence while allowing a bounded matrix to advance to unattempted variants. */
export const canReuseVariant = (input: {
  readonly project: string;
  readonly variant: string;
  readonly finishedVariants: readonly string[];
  readonly cases: readonly ProgressCase[];
  readonly retryFailures: boolean;
}): boolean => {
  if (!input.finishedVariants.includes(`${input.project}/${input.variant}`)) {
    return false;
  }
  const cases = input.cases.filter((row) => row.project === input.project && row.variant === input.variant);
  return cases.length > 0 && (!input.retryFailures || cases.every((row) => row.error === undefined));
};
