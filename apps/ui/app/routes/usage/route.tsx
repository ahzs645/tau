import { useMemo } from 'react';
import { Link } from 'react-router';
import { Filter, RefreshCw, X } from 'lucide-react';
import { Button } from '#components/ui/button.js';
import { DateRangePicker } from '#components/ui/date-range-picker.js';
import { Loader } from '#components/ui/loader.js';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { Badge } from '#components/ui/badge.js';
import { useAllUsage } from '#hooks/use-all-usage.js';
import { useUsageFilters } from '#routes/usage/use-usage-filters.js';
import { UsageSummaryCards } from '#routes/usage/usage-summary-cards.js';
import { UsageLineChart } from '#routes/usage/charts/usage-line-chart.js';
import { UsageBarChart } from '#routes/usage/charts/usage-bar-chart.js';
import { UsageStackedChart } from '#routes/usage/charts/usage-stacked-chart.js';
import { UsagePieChart } from '#routes/usage/charts/usage-pie-chart.js';
import { UsageTable } from '#routes/usage/usage-table.js';
import type { Handle } from '#types/matches.types.js';

export const handle: Handle = {
  breadcrumb() {
    return (
      <Button asChild variant="ghost">
        <Link to="/usage">Usage</Link>
      </Button>
    );
  },
  enableOverflowY: true,
};

export default function UsageDashboard(): React.JSX.Element {
  const { records: allRecords, isLoading, error, refetch } = useAllUsage();
  const {
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
  } = useUsageFilters(allRecords);

  // Apply filters to get filtered records
  const filteredRecords = useMemo(() => applyFilters(allRecords), [applyFilters, allRecords]);

  // Check if any dropdown filters are active (excludes date range which is always set)
  const hasActiveFilters = useMemo(
    () => filters.models.length > 0 || filters.providers.length > 0 || filters.builds.length > 0,
    [filters.models, filters.providers, filters.builds],
  );

  const handleModelToggle = (model: string): void => {
    const newModels = filters.models.includes(model)
      ? filters.models.filter((m) => m !== model)
      : [...filters.models, model];
    setModels(newModels);
  };

  const handleProviderToggle = (provider: string): void => {
    const newProviders = filters.providers.includes(provider)
      ? filters.providers.filter((p) => p !== provider)
      : [...filters.providers, provider];
    setProviders(newProviders);
  };

  const handleBuildToggle = (buildId: string): void => {
    const newBuilds = filters.builds.includes(buildId)
      ? filters.builds.filter((b) => b !== buildId)
      : [...filters.builds, buildId];
    setBuilds(newBuilds);
  };

  if (isLoading) {
    return (
      <div className="container flex h-full flex-col items-center justify-center gap-4 px-4 py-8">
        <Loader className="size-8" />
        <p className="text-muted-foreground">Loading usage data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container flex h-full flex-col items-center justify-center gap-4 px-4 py-8">
        <p className="text-destructive">Error loading usage data: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-6 px-4 py-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Usage Dashboard</h1>
          <p className="mt-1 text-muted-foreground">Track AI model usage and costs across all your builds.</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker withPresets value={filters.dateRange} onChange={setDateRange} />

        {/* Model Filter */}
        {availableModels.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Filter className="size-4" />
                Models
                {filters.models.length > 0 ? (
                  <Badge variant="secondary" className="ml-1 rounded-full px-1.5 py-0.5 text-xs">
                    {filters.models.length}
                  </Badge>
                ) : undefined}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-[300px] w-56 overflow-y-auto">
              <DropdownMenuLabel>Filter by Model</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {availableModels.map((model) => (
                <DropdownMenuCheckboxItem
                  key={model}
                  checked={filters.models.includes(model)}
                  onSelect={(event) => {
                    event.preventDefault();
                  }}
                  onCheckedChange={() => {
                    handleModelToggle(model);
                  }}
                >
                  {model}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined}

        {/* Provider Filter */}
        {availableProviders.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Filter className="size-4" />
                Providers
                {filters.providers.length > 0 ? (
                  <Badge variant="secondary" className="ml-1 rounded-full px-1.5 py-0.5 text-xs">
                    {filters.providers.length}
                  </Badge>
                ) : undefined}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuLabel>Filter by Provider</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {availableProviders.map((provider) => (
                <DropdownMenuCheckboxItem
                  key={provider}
                  checked={filters.providers.includes(provider)}
                  onSelect={(event) => {
                    event.preventDefault();
                  }}
                  onCheckedChange={() => {
                    handleProviderToggle(provider);
                  }}
                >
                  {provider}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined}

        {/* Build Filter */}
        {availableBuilds.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Filter className="size-4" />
                Builds
                {filters.builds.length > 0 ? (
                  <Badge variant="secondary" className="ml-1 rounded-full px-1.5 py-0.5 text-xs">
                    {filters.builds.length}
                  </Badge>
                ) : undefined}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-[300px] w-56 overflow-y-auto">
              <DropdownMenuLabel>Filter by Build</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {availableBuilds.map((build) => (
                <DropdownMenuCheckboxItem
                  key={build.id}
                  checked={filters.builds.includes(build.id)}
                  onSelect={(event) => {
                    event.preventDefault();
                  }}
                  onCheckedChange={() => {
                    handleBuildToggle(build.id);
                  }}
                >
                  <span className="max-w-[180px] truncate">{build.name}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined}

        {/* Clear Filters */}
        {hasActiveFilters ? (
          <Button variant="ghost" size="sm" className="gap-2" onClick={clearFilters}>
            <X className="size-4" />
            Clear filters
          </Button>
        ) : undefined}

        {/* Refresh Button */}
        <Button variant="outline" size="sm" className="ml-auto gap-2" onClick={refetch}>
          <RefreshCw className="size-4" />
          Refresh
        </Button>
      </div>

      {/* Summary Cards */}
      <UsageSummaryCards records={filteredRecords} />

      {/* Charts Grid */}
      <div className="grid gap-4 lg:grid-cols-2">
        <UsageLineChart records={filteredRecords} description="Daily cost trend" />
        <UsageBarChart records={filteredRecords} description="Top models by cost" />
        <UsageStackedChart records={filteredRecords} description="Token composition by day" />
        <UsagePieChart records={filteredRecords} description="Cost distribution by provider" />
      </div>

      {/* Data Table */}
      <UsageTable records={filteredRecords} description="Detailed usage records" height={500} />
    </div>
  );
}
