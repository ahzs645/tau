import { Badge } from '#components/ui/badge.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';

export function AlphaBadge(): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge className='h-7 cursor-help border-purple/30 bg-purple/10 font-normal text-purple dark:text-purple/70'>
          ALPHA
        </Badge>
      </TooltipTrigger>
      <TooltipContent className='max-w-42 text-balance'>
        <p className='font-semibold'>Tau is in Alpha</p>
        <p className='mt-1 text-white/80'>Features may be unstable and change without notice.</p>
      </TooltipContent>
    </Tooltip>
  );
}
