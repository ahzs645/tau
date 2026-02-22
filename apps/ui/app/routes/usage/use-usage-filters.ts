import { useState, useMemo, useCallback } from 'react';
import type { DateRange } from 'react-day-picker';
import { subDays, isWithinInterval, startOfDay, endOfDay } from 'date-fns';
import type { UsageRecord } from '#hooks/use-all-usage.js';

export type UsageFilters = {
  dateRange: DateRange | undefined;
  models: string[];
  providers: string[];
  builds: string[];
};

type UseUsageFiltersReturn = {
  filters: UsageFilters;
  setDateRange: (range: DateRange | undefined) => void;
  setModels: (models: string[]) => void;
  setProviders: (providers: string[]) => void;
  setBuilds: (builds: string[]) => void;
  clearFilters: () => void;
  applyFilters: (records: UsageRecord[]) => UsageRecord[];
  availableModels: string[];
  availableProviders: string[];
  availableBuilds: Array<{ id: string; name: string }>;
};

const defaultDateRange: DateRange = {
  from: subDays(new Date(), 30),
  to: new Date(),
};

/**
 * Hook to manage usage filter state and apply filters to usage records.
 */
export function useUsageFilters(records: UsageRecord[]): UseUsageFiltersReturn {
  const [dateRange, setDateRange] = useState<DateRange | undefined>(defaultDateRange);
  const [models, setModels] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [builds, setBuilds] = useState<string[]>([]);

  // Extract available filter options from records
  const availableModels = useMemo(() => {
    const modelSet = new Set<string>();
    for (const record of records) {
      modelSet.add(record.modelName);
    }

    return [...modelSet].sort();
  }, [records]);

  const availableProviders = useMemo(() => {
    const providerSet = new Set<string>();
    for (const record of records) {
      providerSet.add(record.provider);
    }

    return [...providerSet].sort();
  }, [records]);

  const availableBuilds = useMemo(() => {
    const buildMap = new Map<string, string>();
    for (const record of records) {
      buildMap.set(record.buildId, record.buildName);
    }

    return [...buildMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [records]);

  const clearFilters = useCallback(() => {
    setDateRange(defaultDateRange);
    setModels([]);
    setProviders([]);
    setBuilds([]);
  }, []);

  const applyFilters = useCallback(
    (inputRecords: UsageRecord[]): UsageRecord[] => {
      return inputRecords.filter((record) => {
        // Date range filter
        if (dateRange?.from && dateRange.to) {
          const recordDate = record.date;
          const isInRange = isWithinInterval(recordDate, {
            start: startOfDay(dateRange.from),
            end: endOfDay(dateRange.to),
          });
          if (!isInRange) {
            return false;
          }
        }

        // Model filter
        if (models.length > 0 && !models.includes(record.modelName)) {
          return false;
        }

        // Provider filter
        if (providers.length > 0 && !providers.includes(record.provider)) {
          return false;
        }

        // Build filter
        if (builds.length > 0 && !builds.includes(record.buildId)) {
          return false;
        }

        return true;
      });
    },
    [dateRange, models, providers, builds],
  );

  const filters: UsageFilters = useMemo(
    () => ({
      dateRange,
      models,
      providers,
      builds,
    }),
    [dateRange, models, providers, builds],
  );

  return {
    filters,
    setDateRange,
    setModels,
    setProviders,
    setBuilds,
    clearFilters,
    applyFilters,
    availableModels,
    availableProviders,
    availableBuilds,
  };
}
