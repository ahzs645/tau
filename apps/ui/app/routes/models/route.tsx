import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { SortingState } from '@tanstack/react-table';
import type { Model } from '@taucad/chat';
import { Button } from '#components/ui/button.js';
import { DataTable, DataTableSearch, DataTablePagination } from '#components/ui/data-table.js';
import { useModels } from '#hooks/use-models.js';
import { createColumns } from '#routes/models/columns.js';
import type { Handle } from '#types/matches.types.js';

export const handle: Handle = {
  breadcrumb() {
    return (
      <Button asChild variant="ghost">
        <Link to="/models">Models</Link>
      </Button>
    );
  },
};

export default function Models(): React.JSX.Element {
  const { data: models, selectedModel, setSelectedModelId } = useModels();
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const [globalFilter, setGlobalFilter] = useState('');

  const columns = useMemo(() => createColumns({ selectedModelId: selectedModel?.id }), [selectedModel?.id]);

  const table = useReactTable({
    data: models ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    onGlobalFilterChange: setGlobalFilter,
    getFilteredRowModel: getFilteredRowModel(),
    state: {
      sorting,
      globalFilter,
    },
    initialState: {
      pagination: {
        pageSize: 20,
      },
    },
  });

  const handleRowClick = (model: Model): void => {
    setSelectedModelId(model.id);
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Models</h1>
        <p className="mt-1 text-muted-foreground">
          Select a model to use as your default for AI chat. Click on a row to select it.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <DataTableSearch table={table} placeholder="Search models..." containerClassName="max-w-sm" />
          {selectedModel ? (
            <div className="text-sm text-muted-foreground">
              Current: <span className="font-medium text-foreground">{selectedModel.name}</span>
            </div>
          ) : undefined}
        </div>

        <DataTable table={table} columns={columns} emptyMessage="No models available." onRowClick={handleRowClick} />

        <DataTablePagination table={table} withSelectedCount={false} />
      </div>
    </div>
  );
}
