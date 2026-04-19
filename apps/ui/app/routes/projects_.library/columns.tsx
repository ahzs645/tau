import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRight } from 'lucide-react';
import { NavLink } from 'react-router';
import type { ReactNode } from 'react';
import type { Project, EngineeringDiscipline } from '@taucad/types';
import { CategoryBadge } from '#components/category-badge.js';
import { DataTableColumnHeader } from '#components/ui/data-table.js';
import { Button } from '#components/ui/button.js';
import { Checkbox } from '#components/ui/checkbox.js';
import { formatRelativeTime } from '#utils/date.utils.js';
import type { ProjectActions } from '#routes/projects_.library/route.js';
import { ProjectActionDropdown } from '#routes/projects_.library/project-action-dropdown.js';
import { Loader } from '#components/ui/loader.js';
import { InlineTextEditor } from '#components/inline-text-editor.js';

// Rename component for table cells
function ProjectNameCell({ project, actions }: { readonly project: Project; readonly actions: ProjectActions }) {
  return (
    <div className='flex w-full items-center justify-between gap-3 pr-2'>
      <div className='flex items-center gap-3'>
        <div className='relative h-9 w-9 shrink-0 overflow-hidden rounded-full'>
          <img
            src={project.thumbnail || '/placeholder.svg'}
            alt={project.name}
            className='absolute inset-0 h-full w-full object-cover'
          />
          {!project.thumbnail && !project.author.avatar && (
            <div className='absolute inset-0 flex items-center justify-center bg-muted text-muted-foreground'>
              {project.name.charAt(0)}
            </div>
          )}
        </div>
        <InlineTextEditor
          value={project.name}
          className='h-7 [&_[data-slot=button]]:font-medium'
          onSave={async (value) => actions.handleRename(project.id, value)}
        />
      </div>
    </div>
  );
}

// Create a factory function for columns that accepts actions
export const createColumns = (actions: ProjectActions): Array<ColumnDef<Project>> => [
  {
    id: 'select',
    header: ({ table }) => (
      <div className='pl-2'>
        <Checkbox
          checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && 'indeterminate')}
          aria-label='Select all'
          onCheckedChange={(value) => {
            table.toggleAllPageRowsSelected(Boolean(value));
          }}
        />
      </div>
    ),
    cell: ({ row }) => (
      <div className='pl-2'>
        <Checkbox
          checked={row.getIsSelected()}
          aria-label='Select row'
          onCheckedChange={(value) => {
            row.toggleSelected(Boolean(value));
          }}
        />
      </div>
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'name',
    header: ({ column }) => <DataTableColumnHeader column={column} title='Name' />,
    cell({ row }): ReactNode {
      return <ProjectNameCell project={row.original} actions={actions} />;
    },
    enableSorting: true,
    enableHiding: false,
  },
  {
    accessorKey: 'description',
    header: ({ column }) => <DataTableColumnHeader column={column} title='Description' />,
    cell({ row }): ReactNode {
      return <div className='max-w-xs truncate'>{row.original.description}</div>;
    },
    enableHiding: true,
  },
  {
    accessorKey: 'assets',
    header: ({ column }) => <DataTableColumnHeader column={column} title='Assets' />,
    cell({ row }): ReactNode {
      const project = row.original;
      return (
        <div className='flex flex-wrap gap-2'>
          {(Object.keys(project.assets) as EngineeringDiscipline[]).map((cat) => (
            <CategoryBadge key={cat} category={cat} />
          ))}
        </div>
      );
    },
    enableSorting: false,
    enableHiding: true,
  },
  {
    accessorKey: 'updatedAt',
    header: ({ column }) => <DataTableColumnHeader column={column} title='Last Updated' />,
    cell({ row }): ReactNode {
      return <div>{formatRelativeTime(row.original.updatedAt)}</div>;
    },
    sortingFn: 'datetime',
    enableHiding: true,
  },
  {
    id: 'actions',
    cell({ row }): ReactNode {
      const project = row.original;
      const isDeleted = Boolean(project.deletedAt);

      return (
        <div className='flex items-center justify-end gap-2'>
          <ProjectActionDropdown project={project} actions={actions} />

          {!isDeleted && (
            <Button asChild variant='outline' size='sm' className='ml-auto flex items-center gap-1'>
              <NavLink to={`/projects/${project.id}`}>
                {({ isPending }) =>
                  isPending ? (
                    <Loader />
                  ) : (
                    <>
                      Open
                      <ArrowRight />
                    </>
                  )
                }
              </NavLink>
            </Button>
          )}
        </div>
      );
    },
    enableHiding: false,
  },
];
