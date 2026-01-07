import { useMemo } from 'react';
import { DollarSign } from 'lucide-react';
import type { MyMetadata } from '@taucad/chat';
import { SvgIcon } from '#components/icons/svg-icon.js';
import { InfoTooltip } from '#components/ui/info-tooltip.js';
import { Badge } from '#components/ui/badge.js';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '#components/ui/hover-card.js';
import { TableHeader, TableRow, TableHead, TableBody, TableCell, TableFooter, Table } from '#components/ui/table.js';
import { useModels } from '#hooks/use-models.js';
import { formatCurrency } from '#utils/currency.utils.js';
import { formatNumber } from '#utils/number.utils.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';

type TurnUsage = NonNullable<MyMetadata['turns']>[number];

// Single metadata usage component
export function ChatMessageMetadataUsage({
  metadata,
}: {
  readonly metadata: MyMetadata;
}): React.JSX.Element | undefined {
  const { data: models } = useModels();
  const [showModelCost] = useCookie(cookieName.chatModelCost, true);

  // Calculate totals from turns array
  const { totals, turns, hasMultipleTurns } = useMemo(() => {
    const turnsData = metadata.turns ?? [];
    const hasMultiple = turnsData.length > 1;

    if (turnsData.length === 0) {
      return { totals: undefined, turns: [] as TurnUsage[], hasMultipleTurns: false };
    }

    // Calculate totals from turns using a loop
    const calculated = {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      inputTokensCost: 0,
      outputTokensCost: 0,
      cachedReadTokensCost: 0,
      cachedWriteTokensCost: 0,
      usageCost: 0,
    };

    for (const turn of turnsData) {
      calculated.inputTokens += turn.inputTokens;
      calculated.outputTokens += turn.outputTokens;
      calculated.cachedReadTokens += turn.cachedReadTokens;
      calculated.cachedWriteTokens += turn.cachedWriteTokens ?? 0;
      calculated.inputTokensCost += turn.inputTokensCost ?? 0;
      calculated.outputTokensCost += turn.outputTokensCost ?? 0;
      calculated.cachedReadTokensCost += turn.cachedReadTokensCost ?? 0;
      calculated.cachedWriteTokensCost += turn.cachedWriteTokensCost ?? 0;
      calculated.usageCost += turn.usageCost ?? 0;
    }

    return { totals: calculated, turns: turnsData, hasMultipleTurns: hasMultiple };
  }, [metadata.turns]);

  if (!totals) {
    return undefined;
  }

  const model = models?.find((m) => m.id === metadata.model);
  const totalTokens = totals.inputTokens + totals.outputTokens + totals.cachedReadTokens + totals.cachedWriteTokens;
  const totalCost = totals.usageCost;

  return (
    <HoverCard openDelay={100} closeDelay={100}>
      <HoverCardTrigger asChild className="flex flex-row items-center" tabIndex={0}>
        <Badge
          variant="outline"
          className="h-7 cursor-help gap-0 border-none font-medium text-inherit outline-none hover:bg-neutral/20"
        >
          <DollarSign className="size-3.5! stroke-2" />
          {showModelCost ? <span>{formatCurrency(totalCost, { significantFigures: 2 })}</span> : undefined}
        </Badge>
      </HoverCardTrigger>
      <HoverCardContent className="w-auto p-2 pt-1">
        <div className="flex flex-col space-y-1">
          <div className="flex flex-row items-baseline justify-between gap-4 p-2 pb-0">
            <h4 className="font-medium">Usage Details</h4>
            {model ? (
              <div className="flex items-baseline gap-2 text-xs">
                <SvgIcon id={model.provider.id} className="size-4 translate-y-[0.25em] text-muted-foreground" />
                <span className="font-mono">{model.name}</span>
              </div>
            ) : undefined}
          </div>
          <Table className="overflow-clip rounded-md">
            <TableHeader>
              <TableRow>
                <TableHead>Metric</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hasMultipleTurns ? (
                // Display per-turn breakdown for multi-turn messages
                <>
                  {turns.map((turn: TurnUsage) => {
                    const turnTokens =
                      turn.inputTokens + turn.outputTokens + turn.cachedReadTokens + (turn.cachedWriteTokens ?? 0);
                    const turnCost = turn.usageCost ?? 0;
                    return (
                      <TableRow key={turn.turnIndex}>
                        <TableCell className="flex flex-row items-center gap-1">
                          <span>Turn {turn.turnIndex + 1}</span>
                          <InfoTooltip>
                            <div className="space-y-1 text-xs">
                              <div>Input: {formatNumber(turn.inputTokens)} tokens</div>
                              <div>Output: {formatNumber(turn.outputTokens)} tokens</div>
                              {turn.cachedReadTokens > 0 && (
                                <div>Cached Read: {formatNumber(turn.cachedReadTokens)} tokens</div>
                              )}
                              {(turn.cachedWriteTokens ?? 0) > 0 && (
                                <div>Cached Write: {formatNumber(turn.cachedWriteTokens ?? 0)} tokens</div>
                              )}
                            </div>
                          </InfoTooltip>
                        </TableCell>
                        <TableCell className="text-right">{formatNumber(turnTokens)}</TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(turnCost, { significantFigures: 2 })}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </>
              ) : (
                // Display detailed breakdown for single-turn messages
                <>
                  <TableRow>
                    <TableCell className="flex flex-row items-center gap-1">
                      <span>Input</span>
                      <InfoTooltip>
                        The number of tokens in the input prompt. This includes the user prompt, system message, and any
                        previous messages.
                      </InfoTooltip>
                    </TableCell>
                    <TableCell className="text-right">{formatNumber(totals.inputTokens)}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(totals.inputTokensCost, { significantFigures: 2 })}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="flex flex-row items-center gap-1">
                      <span>Output</span>
                      <InfoTooltip>The number of tokens in the output response.</InfoTooltip>
                    </TableCell>
                    <TableCell className="text-right">{formatNumber(totals.outputTokens)}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(totals.outputTokensCost, { significantFigures: 2 })}
                    </TableCell>
                  </TableRow>
                  {totals.cachedReadTokens > 0 && (
                    <TableRow>
                      <TableCell className="flex flex-row items-center gap-1">
                        <span>Cached Read</span>
                        <InfoTooltip>
                          The number of tokens read from the prompt cache. This improves performance by avoiding
                          re-processing the same prompt.
                        </InfoTooltip>
                      </TableCell>
                      <TableCell className="text-right">{formatNumber(totals.cachedReadTokens)}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(totals.cachedReadTokensCost, { significantFigures: 2 })}
                      </TableCell>
                    </TableRow>
                  )}
                  {totals.cachedWriteTokens > 0 ? (
                    <TableRow>
                      <TableCell className="flex flex-row items-center gap-1">
                        <span>Cached Write</span>
                        <InfoTooltip>
                          The number of tokens written to the prompt cache. This improves performance by avoiding
                          re-processing the same prompt.
                        </InfoTooltip>
                      </TableCell>
                      <TableCell className="text-right">{formatNumber(totals.cachedWriteTokens)}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(totals.cachedWriteTokensCost, { significantFigures: 2 })}
                      </TableCell>
                    </TableRow>
                  ) : undefined}
                </>
              )}
            </TableBody>
            <TableFooter className="overflow-clip rounded-b-md">
              <TableRow>
                <TableCell>Total</TableCell>
                <TableCell className="text-right">{formatNumber(totalTokens)}</TableCell>
                <TableCell className="text-right">{formatCurrency(totalCost, { significantFigures: 2 })}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
