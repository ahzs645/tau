import React, { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { format, startOfDay } from 'date-fns';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '#components/ui/chart.js';
import type { ChartConfig } from '#components/ui/chart.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#components/ui/card.js';
import { formatCurrency } from '#utils/currency.utils.js';
import type { UsageRecord } from '#hooks/use-all-usage.js';

type UsageLineChartProps = {
  readonly records: UsageRecord[];
  readonly title?: string;
  readonly description?: string;
};

type DailyData = {
  date: string;
  dateLabel: string;
  cost: number;
};

const chartConfig: ChartConfig = {
  cost: {
    label: 'Cost',
    color: 'var(--primary)',
  },
};

/**
 * Aggregate records by day (UTC).
 */
function aggregateByDay(records: UsageRecord[]): DailyData[] {
  const dailyMap = new Map<string, number>();

  for (const record of records) {
    // Use UTC date string for bucketing
    const dateKey = record.date.toISOString().split('T')[0] ?? '';
    const currentCost = dailyMap.get(dateKey) ?? 0;
    dailyMap.set(dateKey, currentCost + record.totalCost);
  }

  // Sort by date and convert to array
  const sortedEntries = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return sortedEntries.map(([dateKey, cost]) => ({
    date: dateKey,
    dateLabel: dateKey ? format(startOfDay(new Date(dateKey)), 'MMM d') : '',
    cost,
  }));
}

function UsageLineChartComponent({
  records,
  title = 'Cost Over Time',
  description,
}: UsageLineChartProps): React.JSX.Element {
  const chartData = useMemo(() => aggregateByDay(records), [records]);

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
    <Card className="min-w-0 overflow-hidden">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : undefined}
      </CardHeader>
      <CardContent className="min-w-0">
        <ChartContainer config={chartConfig} className="h-[300px] w-full min-w-0">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="fillCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-cost)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="var(--color-cost)" stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="dateLabel" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis
              tickFormatter={(value: number) => formatCurrency(value, { significantFigures: 1 })}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={60}
            />
            {/* @ts-expect-error - ChartTooltipContent types don't match Recharts exactly */}
            <ChartTooltip cursor={false} content={ChartTooltipContent} />
            <Area type="monotone" dataKey="cost" stroke="var(--color-cost)" fill="url(#fillCost)" strokeWidth={2} />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export const UsageLineChart = React.memo(UsageLineChartComponent);
