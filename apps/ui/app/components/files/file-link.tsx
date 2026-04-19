import { useCallback } from 'react';
import { Slot as SlotPrimitive } from 'radix-ui';
import { useProject } from '#hooks/use-project.js';
import { cn } from '#utils/ui.utils.js';

type FileLinkProps = {
  readonly path: string;
  readonly lineNumber?: number;
  readonly column?: number;
  readonly className?: string;
  readonly children: React.ReactNode;
  /**
   * When true, merges props onto child element instead of rendering a button.
   */
  readonly asChild?: boolean;
};

/**
 * Clickable link component that opens a file in the editor.
 *
 * Internalizes the file explorer state machine event emission for opening files.
 *
 * @example
 * // Basic usage - renders as a button
 * <FileLink path="main.kcl" lineNumber={10}>
 *   main.kcl:10
 * </FileLink>
 *
 * @example
 * // With asChild - merges onto child element
 * <FileLink path="main.kcl" asChild>
 *   <span className="custom-styles">main.kcl</span>
 * </FileLink>
 */
export function FileLink({
  path,
  lineNumber,
  column,
  className,
  children,
  asChild = false,
}: FileLinkProps): React.JSX.Element {
  const project = useProject({ enableNoContext: true });

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (!project) {
        return;
      }

      project.editorRef.send({
        type: 'openFile',
        path,
        source: 'user',
        lineNumber: lineNumber ?? 1,
        column: column ?? 1,
      });
    },
    [project, path, lineNumber, column],
  );

  const Component = asChild ? SlotPrimitive.Slot : 'button';

  return (
    <Component
      type={asChild ? undefined : 'button'}
      className={cn(
        'cursor-pointer decoration-current underline-offset-2 hover:text-foreground hover:underline',
        className,
      )}
      onClick={handleClick}
    >
      {children}
    </Component>
  );
}
