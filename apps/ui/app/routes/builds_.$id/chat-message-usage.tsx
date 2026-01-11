import { useMemo } from 'react';
import { DollarSign } from 'lucide-react';
import type { UsageData } from '@taucad/chat';
import { SvgIcon } from '#components/icons/svg-icon.js';
import { InfoTooltip } from '#components/ui/info-tooltip.js';
import { Badge } from '#components/ui/badge.js';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '#components/ui/hover-card.js';
import { TableHeader, TableRow, TableHead, TableBody, TableCell, TableFooter, Table } from '#components/ui/table.js';
import { useModels } from '#hooks/use-models.js';
import { formatCurrency } from '#utils/currency.utils.js';
import { formatNumberAbbreviation } from '#utils/number.utils.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';

type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  inputTokensCost: number;
  outputTokensCost: number;
  cachedReadTokensCost: number;
  cachedWriteTokensCost: number;
  totalCost: number;
};

/**
 * Component for displaying usage data from data parts.
 * Aggregates multiple usage parts across agent turns and displays totals.
 */
export function ChatMessageUsage({ usageParts }: { readonly usageParts: UsageData[] }): React.JSX.Element | undefined {
  const { data: models } = useModels();
  const [showModelCost] = useCookie(cookieName.chatModelCost, true);

  // Calculate totals from usage parts
  const { totals, hasMultipleTurns, model } = useMemo(() => {
    if (usageParts.length === 0) {
      return { totals: undefined, hasMultipleTurns: false, model: undefined };
    }

    const hasMultiple = usageParts.length > 1;

    // Calculate totals from all usage parts
    const calculated: UsageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      inputTokensCost: 0,
      outputTokensCost: 0,
      cachedReadTokensCost: 0,
      cachedWriteTokensCost: 0,
      totalCost: 0,
    };

    for (const usage of usageParts) {
      calculated.inputTokens += usage.inputTokens;
      calculated.outputTokens += usage.outputTokens;
      calculated.cachedReadTokens += usage.cachedReadTokens;
      calculated.cachedWriteTokens += usage.cachedWriteTokens;
      calculated.inputTokensCost += usage.inputTokensCost;
      calculated.outputTokensCost += usage.outputTokensCost;
      calculated.cachedReadTokensCost += usage.cachedReadTokensCost;
      calculated.cachedWriteTokensCost += usage.cachedWriteTokensCost;
      calculated.totalCost += usage.totalCost;
    }

    // Use the model from the last usage part (most recent)
    const lastUsage = usageParts.at(-1);
    const modelId = lastUsage?.model;
    const foundModel = modelId ? models?.find((m) => m.id === modelId) : undefined;

    return { totals: calculated, hasMultipleTurns: hasMultiple, model: foundModel };
  }, [usageParts, models]);

  if (!totals) {
    return undefined;
  }

  const totalTokens = totals.inputTokens + totals.outputTokens + totals.cachedReadTokens + totals.cachedWriteTokens;

  return (
    <HoverCard openDelay={100} closeDelay={100}>
      <HoverCardTrigger asChild className="flex flex-row items-center" tabIndex={0}>
        <Badge
          variant="outline"
          className="h-7 cursor-help gap-0 border-none font-medium text-inherit outline-none hover:bg-neutral/20"
        >
          <DollarSign className="size-3.5! stroke-2" />
          {showModelCost ? <span>{formatCurrency(totals.totalCost, { significantFigures: 2 })}</span> : undefined}
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
                  {usageParts.map((usage, index) => {
                    const turnTokens =
                      usage.inputTokens + usage.outputTokens + usage.cachedReadTokens + usage.cachedWriteTokens;
                    return (
                      <TableRow key={usage.id}>
                        <TableCell className="flex flex-row items-center gap-1">
                          <span>Turn {index + 1}</span>
                          <InfoTooltip>
                            <div className="space-y-1 text-xs">
                              <div>Input: {formatNumberAbbreviation(usage.inputTokens)} tokens</div>
                              <div>Output: {formatNumberAbbreviation(usage.outputTokens)} tokens</div>
                              {usage.cachedReadTokens > 0 && (
                                <div>Cached Read: {formatNumberAbbreviation(usage.cachedReadTokens)} tokens</div>
                              )}
                              {usage.cachedWriteTokens > 0 && (
                                <div>Cached Write: {formatNumberAbbreviation(usage.cachedWriteTokens)} tokens</div>
                              )}
                            </div>
                          </InfoTooltip>
                        </TableCell>
                        <TableCell className="text-right font-mono">{formatNumberAbbreviation(turnTokens)}</TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(usage.totalCost, { significantFigures: 2 })}
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
                    <TableCell className="text-right font-mono">
                      {formatNumberAbbreviation(totals.inputTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCurrency(totals.inputTokensCost, { significantFigures: 2 })}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="flex flex-row items-center gap-1">
                      <span>Output</span>
                      <InfoTooltip>The number of tokens in the output response.</InfoTooltip>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatNumberAbbreviation(totals.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
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
                      <TableCell className="text-right font-mono">
                        {formatNumberAbbreviation(totals.cachedReadTokens)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
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
                      <TableCell className="text-right font-mono">
                        {formatNumberAbbreviation(totals.cachedWriteTokens)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
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
                <TableCell className="text-right font-mono">{formatNumberAbbreviation(totalTokens)}</TableCell>
                <TableCell className="text-right font-mono">
                  {formatCurrency(totals.totalCost, { significantFigures: 2 })}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
