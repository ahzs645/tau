import type { FileExtension } from '@taucad/types';

export type ExportFormatOption = {
  format: FileExtension;
  label: string;
};

/**
 * Derive a deduplicated list of export format options from a manifest.
 *
 * Intentionally kernel-agnostic: the hero viewer renders a single hardcoded file
 * with a known kernel, so first-occurrence deduplication on `targetFormat` is
 * sufficient (unlike ChatConverter which filters by activeKernelId).
 */
export function deriveExportFormatOptions(
  capabilities: { routes: ReadonlyArray<{ targetFormat: FileExtension }> } | undefined,
): ExportFormatOption[] {
  if (!capabilities) {
    return [];
  }
  const seen = new Set<FileExtension>();
  const options: ExportFormatOption[] = [];
  for (const route of capabilities.routes) {
    if (seen.has(route.targetFormat)) {
      continue;
    }
    seen.add(route.targetFormat);
    options.push({ format: route.targetFormat, label: route.targetFormat.toUpperCase() });
  }
  return options;
}
