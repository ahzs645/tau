import type { FileParameterConfig, FileParameterEntry } from '@taucad/types';

const defaultParameterSetName = 'default';

/**
 * Parse a JSON string into a validated FileParameterConfig.
 * Throws on invalid JSON or missing version field.
 */
export const parseParameterConfig = (json: string): FileParameterConfig => {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    (parsed as { version: unknown }).version !== 1
  ) {
    throw new Error('Invalid parameter config: missing or unsupported version');
  }
  return parsed as FileParameterConfig;
};

/**
 * Create a default config with a single file entry and empty default set.
 */
export const createDefaultConfig = (mainEntryFile: string): FileParameterConfig => ({
  version: 1,
  files: {
    [mainEntryFile]: {
      activeSet: defaultParameterSetName,
      sets: {
        [defaultParameterSetName]: { values: {} },
      },
    },
  },
});

/**
 * Get the active parameter set values for a file.
 * Returns an empty object if the file or set is not found.
 */
export const getActiveSetValues = (config: FileParameterConfig, filePath: string): Record<string, unknown> => {
  const entry = config.files[filePath];
  if (!entry) {
    return {};
  }
  return entry.sets[entry.activeSet]?.values ?? {};
};

/**
 * Return a new config with updated values for a specific set in a file entry.
 * Creates the file entry and set if they don't exist.
 */
export const updateSetValues = (
  config: FileParameterConfig,
  options: { filePath: string; setName: string; values: Record<string, unknown> },
): FileParameterConfig => {
  const { filePath, setName, values } = options;
  const existingEntry: FileParameterEntry = config.files[filePath] ?? {
    activeSet: setName,
    sets: {},
  };

  return {
    ...config,
    files: {
      ...config.files,
      [filePath]: {
        ...existingEntry,
        sets: {
          ...existingEntry.sets,
          [setName]: { values },
        },
      },
    },
  };
};

/**
 * Create a new parameter set for a file.
 * Throws if the set already exists.
 */
export const createSet = (
  config: FileParameterConfig,
  options: { filePath: string; setName: string; values?: Record<string, unknown> },
): FileParameterConfig => {
  const { filePath, setName, values = {} } = options;
  const entry = config.files[filePath];
  if (entry?.sets[setName]) {
    throw new Error(`Parameter set "${setName}" already exists for "${filePath}"`);
  }
  return updateSetValues(config, { filePath, setName, values });
};

/**
 * Delete a parameter set from a file entry.
 * Throws if deleting the active set or if the set doesn't exist.
 */
export const deleteSet = (config: FileParameterConfig, filePath: string, setName: string): FileParameterConfig => {
  const entry = config.files[filePath];
  if (!entry?.sets[setName]) {
    throw new Error(`Parameter set "${setName}" does not exist for "${filePath}"`);
  }
  if (entry.activeSet === setName) {
    throw new Error(`Cannot delete the active parameter set "${setName}"`);
  }

  const { [setName]: _, ...remainingSets } = entry.sets;
  return {
    ...config,
    files: {
      ...config.files,
      [filePath]: {
        ...entry,
        sets: remainingSets,
      },
    },
  };
};

/**
 * Switch the active parameter set for a file.
 * Throws if the target set doesn't exist.
 */
export const switchActiveSet = (
  config: FileParameterConfig,
  filePath: string,
  setName: string,
): FileParameterConfig => {
  const entry = config.files[filePath];
  if (!entry?.sets[setName]) {
    throw new Error(`Parameter set "${setName}" does not exist for "${filePath}"`);
  }
  return {
    ...config,
    files: {
      ...config.files,
      [filePath]: {
        ...entry,
        activeSet: setName,
      },
    },
  };
};

/**
 * Validate that a value is a structurally sound FileParameterConfig.
 * Throws with a descriptive message on any structural issue.
 */
export function validateParameterConfig(config: unknown): asserts config is FileParameterConfig {
  if (typeof config !== 'object' || config === null) {
    throw new Error('Invalid parameter config: expected a non-null object');
  }
  if (!('version' in config) || (config as { version: unknown }).version !== 1) {
    throw new Error('Invalid parameter config: missing or unsupported version');
  }
  if (
    !('files' in config) ||
    typeof (config as { files: unknown }).files !== 'object' ||
    (config as { files: unknown }).files === null
  ) {
    throw new Error('Invalid parameter config: missing or invalid files object');
  }
}

/**
 * Serialize a FileParameterConfig to a formatted JSON string.
 *
 * Validates the config structure before serializing and round-trip
 * parses the output to guarantee the written content is recoverable.
 * Throws if validation or round-trip parsing fails.
 */
export const serializeParameterConfig = (config: FileParameterConfig): string => {
  validateParameterConfig(config);
  const json = JSON.stringify(config, null, 2);
  parseParameterConfig(json);
  return json;
};
