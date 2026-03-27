import { useMemo, useState } from 'react';
import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { SortingState } from '@tanstack/react-table';
import type { Model } from '@taucad/chat';
import { DataTable, DataTableSearch, DataTablePagination } from '#components/ui/data-table.js';
import { useModels } from '#hooks/use-models.js';
import { createColumns } from '#components/settings/model-columns.js';

export function ModelSettings(): React.JSX.Element {
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
    <div className='space-y-4'>
      <div className='flex items-center justify-between gap-2'>
        <DataTableSearch table={table} placeholder='Search models...' containerClassName='max-w-sm' />
        {selectedModel ? (
          <div className='text-sm text-muted-foreground'>
            Current: <span className='font-medium text-foreground'>{selectedModel.name}</span>
          </div>
        ) : undefined}
      </div>

      <DataTable table={table} columns={columns} emptyMessage='No models available.' onRowClick={handleRowClick} />

      <DataTablePagination table={table} withSelectedCount={false} />
    </div>
  );
}
