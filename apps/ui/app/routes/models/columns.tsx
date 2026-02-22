import type { ColumnDef } from '@tanstack/react-table';
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { Model } from '@taucad/chat';
import { DataTableColumnHeader } from '#components/ui/data-table.js';
import { Badge } from '#components/ui/badge.js';
import { cn } from '#utils/ui.utils.js';

/**
 * Format token cost for display (cost is already per million tokens)
 * e.g., 3.00 -> "$3.00"
 */
function formatTokenCost(costPerMillion: number): string {
  if (costPerMillion < 0.01) {
    return `$${costPerMillion.toFixed(3)}`;
  }

  return `$${costPerMillion.toFixed(2)}`;
}

/**
 * Get provider badge variant based on provider id
 */
function getProviderVariant(providerId: string): 'default' | 'secondary' | 'outline' {
  switch (providerId) {
    case 'openai': {
      return 'default';
    }

    case 'anthropic': {
      return 'secondary';
    }

    default: {
      return 'outline';
    }
  }
}

type ColumnsContext = {
  selectedModelId: string | undefined;
};

export function createColumns({ selectedModelId }: ColumnsContext): Array<ColumnDef<Model>> {
  return [
    {
      id: 'select',
      header: () => <div className="w-8" />,
      cell({ row }): ReactNode {
        const isSelected = row.original.id === selectedModelId;
        return (
          <div className="flex w-8 items-center justify-center">
            {isSelected ? (
              <div className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="size-3" />
              </div>
            ) : (
              <div className="size-5 rounded-full border-2 border-muted-foreground/30" />
            )}
          </div>
        );
      },
      enableSorting: false,
      enableHiding: false,
    },
    {
      accessorKey: 'name',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Model" />,
      cell({ row }): ReactNode {
        const model = row.original;
        return (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{model.name}</span>
            {model.description ? (
              <span className="max-w-md truncate text-xs text-muted-foreground">{model.description}</span>
            ) : undefined}
          </div>
        );
      },
      enableSorting: true,
      enableHiding: false,
    },
    {
      accessorKey: 'provider',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Provider" />,
      cell({ row }): ReactNode {
        const { provider } = row.original;
        return <Badge variant={getProviderVariant(provider.id)}>{provider.name}</Badge>;
      },
      accessorFn: (row) => row.provider.name,
      enableSorting: true,
      enableHiding: true,
    },
    {
      id: 'inputCost',
      accessorFn: (row) => row.details.cost?.inputTokens,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Input $/M" />,
      cell({ row }): ReactNode {
        const cost = row.original.details.cost?.inputTokens;
        if (cost === undefined) {
          return <span className="text-sm text-muted-foreground/50">—</span>;
        }

        return <span className="font-mono text-sm text-muted-foreground">{formatTokenCost(cost)}</span>;
      },
      enableSorting: true,
      enableHiding: true,
    },
    {
      id: 'outputCost',
      accessorFn: (row) => row.details.cost?.outputTokens,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Output $/M" />,
      cell({ row }): ReactNode {
        const cost = row.original.details.cost?.outputTokens;
        if (cost === undefined) {
          return <span className="text-sm text-muted-foreground/50">—</span>;
        }

        return <span className="font-mono text-sm text-muted-foreground">{formatTokenCost(cost)}</span>;
      },
      enableSorting: true,
      enableHiding: true,
    },
    {
      id: 'family',
      accessorFn: (row) => row.details.family,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Family" />,
      cell({ row }): ReactNode {
        const { family } = row.original.details;
        return (
          <Badge
            variant="outline"
            className={cn(
              'capitalize',
              family === 'claude' && 'border-orange-500/50 text-orange-500',
              family === 'gpt' && 'border-green-500/50 text-green-500',
              family === 'gemini' && 'border-blue-500/50 text-blue-500',
            )}
          >
            {family}
          </Badge>
        );
      },
      enableSorting: true,
      enableHiding: true,
    },
  ];
}
