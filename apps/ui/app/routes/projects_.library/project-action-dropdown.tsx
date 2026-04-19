import { Copy, Ellipsis, Pencil, Trash, ArrowUpRightSquare } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { Project } from '@taucad/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { Button } from '#components/ui/button.js';
import type { ProjectActions } from '#routes/projects_.library/route.js';
import { Popover, PopoverContent } from '#components/ui/popover.js';
import { Input } from '#components/ui/input.js';

type ProjectActionDropdownProps = {
  readonly project: Project;
  readonly actions: ProjectActions;
  readonly shouldStopPropagation?: boolean;
};

export function ProjectActionDropdown({
  project,
  actions,
  shouldStopPropagation = false,
}: ProjectActionDropdownProps): ReactNode {
  const isDeleted = Boolean(project.deletedAt);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(project.name);

  const handleClick = (event: React.MouseEvent): void => {
    if (shouldStopPropagation) {
      event.stopPropagation();
      event.preventDefault();
    }
  };

  const handleRename = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newName.trim() && newName !== project.name) {
      try {
        await actions.handleRename(project.id, newName);
        setIsRenaming(false);
      } catch {
        // Error is already handled in the action
      }
    } else {
      setIsRenaming(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant='ghost' size='icon' onClick={handleClick}>
            <Ellipsis className='size-4' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' onClick={handleClick}>
          {isDeleted ? (
            <DropdownMenuItem
              data-action='restore'
              data-id={project.id}
              data-name={project.name}
              onClick={() => {
                actions.handleRestore(project);
              }}
            >
              <ArrowUpRightSquare />
              <span>Restore</span>
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem
                data-action='duplicate'
                data-id={project.id}
                data-name={project.name}
                onClick={async () => actions.handleDuplicate(project)}
              >
                <Copy />
                <span>Duplicate</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                data-action='rename'
                data-id={project.id}
                data-name={project.name}
                onClick={() => {
                  setNewName(project.name);
                  setIsRenaming(true);
                }}
              >
                <Pencil />
                <span>Rename</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                variant='destructive'
                data-action='delete'
                data-id={project.id}
                data-name={project.name}
                onClick={() => {
                  actions.handleDelete(project);
                }}
              >
                <Trash />
                <span>Delete</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover open={isRenaming} onOpenChange={setIsRenaming}>
        <PopoverContent align='end' className='w-64 p-1'>
          <form className='flex items-center gap-2 align-middle' onSubmit={handleRename}>
            <Input
              autoFocus
              autoComplete='off'
              value={newName}
              className='h-7'
              onChange={(event) => {
                setNewName(event.target.value);
              }}
              onFocus={(event) => {
                event.target.select();
              }}
            />
            <Button type='submit' size='sm' disabled={!newName.trim() || newName === project.name}>
              Save
            </Button>
          </form>
        </PopoverContent>
      </Popover>
    </>
  );
}
