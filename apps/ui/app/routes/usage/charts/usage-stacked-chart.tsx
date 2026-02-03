import React, { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { format, startOfDay } from 'date-fns';
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, type ChartConfig } from '#components/ui/chart.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#components/ui/card.js';
import { formatNumberAbbreviation } from '#utils/number.utils.js';
import type { UsageRecord } from '#hooks/use-all-usage.js';

type UsageStackedChartProps = {
  readonly records: UsageRecord[];
  readonly title?: string;
  readonly description?: string;
};

type DailyTokenData = {
  date: string;
  dateLabel: string;
  input: number;
  output: number;
  cache: number;
};

const chartConfig: ChartConfig = {
  input: {
    label: 'Input',
    color: 'var(--chart-1)',
  },
  output: {
    label: 'Output',
    color: 'var(--chart-2)',
  },
  cache: {
    label: 'Cache',
    color: 'var(--chart-3)',
  },
};

/**
 * Aggregate token types by day (UTC).
 */
function aggregateTokensByDay(records: UsageRecord[]): DailyTokenData[] {
  const dailyMap = new Map<string, { input: number; output: number; cache: number }>();

  for (const record of records) {
    // Use UTC date string for bucketing
    const dateKey = record.date.toISOString().split('T')[0] ?? '';
    const current = dailyMap.get(dateKey) ?? { input: 0, output: 0, cache: 0 };
    dailyMap.set(dateKey, {
      input: current.input + record.inputTokens,
      output: current.output + record.outputTokens,
      cache: current.cache + record.cacheReadTokens + record.cacheWriteTokens,
    });
  }

  // Sort by date and convert to array
  const sortedEntries = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return sortedEntries.map(([dateKey, tokens]) => ({
    date: dateKey,
    dateLabel: dateKey ? format(startOfDay(new Date(dateKey)), 'MMM d') : '',
    ...tokens,
  }));
}

function UsageStackedChartComponent({
  records,
  title = 'Token Usage Over Time',
  description,
}: UsageStackedChartProps): React.JSX.Element {
  const chartData = useMemo(() => aggregateTokensByDay(records), [records]);

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : undefined}
        </CardHeader>
        <CardContent className="flex h-[300px] items-center justify-center">
          <p className="text-sm text-muted-foreground">No data available</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : undefined}
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="fillInput" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-input)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="var(--color-input)" stopOpacity={0.1} />
              </linearGradient>
              <linearGradient id="fillOutput" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-output)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="var(--color-output)" stopOpacity={0.1} />
              </linearGradient>
              <linearGradient id="fillCache" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-cache)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="var(--color-cache)" stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="dateLabel" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis
              tickFormatter={(value: number) => formatNumberAbbreviation(value)}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={60}
            />
            {/* @ts-expect-error - ChartTooltipContent types don't match Recharts exactly */}
            <ChartTooltip cursor={false} content={ChartTooltipContent} />
            <ChartLegend content={<ChartLegendContent />} />
            <Area
              type="monotone"
              dataKey="input"
              stackId="1"
              stroke="var(--color-input)"
              fill="url(#fillInput)"
              strokeWidth={2}
            />
            <Area
              type="monotone"
              dataKey="output"
              stackId="1"
              stroke="var(--color-output)"
              fill="url(#fillOutput)"
              strokeWidth={2}
            />
            <Area
              type="monotone"
              dataKey="cache"
              stackId="1"
              stroke="var(--color-cache)"
              fill="url(#fillCache)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export const UsageStackedChart = React.memo(UsageStackedChartComponent);
