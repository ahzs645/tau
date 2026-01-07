import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { cn } from '#utils/ui.utils.js';

function Collapsible({ ...properties }: React.ComponentProps<typeof CollapsiblePrimitive.Root>): React.JSX.Element {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...properties} />;
}

function CollapsibleTrigger({
  ...properties
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>): React.JSX.Element {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...properties} />;
}

function CollapsibleContent({
  className,
  forceMount,
  ...properties
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent> & {
  // eslint-disable-next-line react/boolean-prop-naming -- Radix UI prop naming convention.
  readonly forceMount?: boolean;
}): React.JSX.Element {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      className={cn(
        // When forceMount is true, use CSS to hide instead of unmounting
        forceMount && 'data-[state=closed]:hidden',
        className,
      )}
      data-slot="collapsible-content"
      forceMount={forceMount ? true : undefined}
      {...properties}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
