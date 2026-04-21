import { useCallback } from 'react';
import { Slot as SlotPrimitive } from 'radix-ui';
import { useProject } from '#hooks/use-project.js';
import { cn } from '#utils/ui.utils.js';

type ViewerLinkProps = {
  readonly path: string;
  readonly className?: string;
  readonly children: React.ReactNode;
  /**
   * When true, merges props onto child element instead of rendering a button.
   */
  readonly asChild?: boolean;
};

/**
 * Clickable link component that opens a file in a new viewer pane.
 *
 * Internalizes the project state machine event emission for opening files in the
 * 3D viewer. Mirrors {@link FileLink} but routes through `openInViewer` so binary
 * geometry artifacts (GLB, STEP, etc.) render in the viewer rather than the editor.
 *
 * @example <caption>Basic usage as a button</caption>
 * ```typescript
 * <ViewerLink path=".tau/artifacts/tc-1__main.glb">.tau/artifacts/tc-1__main.glb</ViewerLink>
 * ```
 *
 * @example <caption>asChild merges onto a styled wrapper</caption>
 * ```typescript
 * <ViewerLink asChild path=".tau/artifacts/tc-1__main.glb">
 *   <div className="rounded-md border px-2 py-1">tc-1__main.glb</div>
 * </ViewerLink>
 * ```
 */
export function ViewerLink({ path, className, children, asChild = false }: ViewerLinkProps): React.JSX.Element {
  const project = useProject({ enableNoContext: true });

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (!project) {
        return;
      }

      project.projectRef.send({ type: 'openInViewer', entryFile: path });
    },
    [project, path],
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
