import { useMemo } from 'react';
import { InfoTooltip } from '#components/ui/info-tooltip.js';
import { TableHeader, TableRow, TableHead, TableBody, TableCell, TableFooter, Table } from '#components/ui/table.js';
import { formatCurrency } from '#utils/currency.utils.js';
import { formatNumber } from '#utils/number.utils.js';
import { useChats } from '#hooks/use-chats.js';
import { useBuild } from '#hooks/use-build.js';

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
 * Component for displaying total usage data across all chats in a build.
 * Self-contained component that extracts its own state from the build context.
 */
export function ChatDetailsUsage(): React.JSX.Element | undefined {
  const { buildId } = useBuild();
  const { chats } = useChats(buildId);

  // Calculate total usage across all chats in the build
  const totals = useMemo(() => {
    const usage: UsageTotals = {
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

    for (const chat of chats) {
      for (const message of chat.messages) {
        for (const part of message.parts) {
          if (part.type === 'data-usage') {
            usage.inputTokens += part.data.inputTokens;
            usage.outputTokens += part.data.outputTokens;
            usage.cachedReadTokens += part.data.cachedReadTokens;
            usage.cachedWriteTokens += part.data.cachedWriteTokens;
            usage.inputTokensCost += part.data.inputTokensCost;
            usage.outputTokensCost += part.data.outputTokensCost;
            usage.cachedReadTokensCost += part.data.cachedReadTokensCost;
            usage.cachedWriteTokensCost += part.data.cachedWriteTokensCost;
            usage.totalCost += part.data.totalCost;
          }
        }
      }
    }

    return usage;
  }, [chats]);

  if (totals.totalCost === 0) {
    return undefined;
  }

  const totalTokens = totals.inputTokens + totals.outputTokens + totals.cachedReadTokens + totals.cachedWriteTokens;

  return (
    <div className="border-t pt-3">
      <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <span>Usage</span>
      </div>

      <Table className="overflow-clip rounded-md -mx-2">
        <TableHeader>
          <TableRow>
            <TableHead>Metric</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="flex flex-row items-center gap-1">
              <span>Input</span>
              <InfoTooltip>
                The number of tokens in input prompts across all chats. This includes user prompts, system messages,
                and conversation history.
              </InfoTooltip>
            </TableCell>
            <TableCell className="text-right">{formatNumber(totals.inputTokens)}</TableCell>
            <TableCell className="text-right">{formatCurrency(totals.inputTokensCost, { significantFigures: 2 })}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="flex flex-row items-center gap-1">
              <span>Output</span>
              <InfoTooltip>The number of tokens in output responses across all chats.</InfoTooltip>
            </TableCell>
            <TableCell className="text-right">{formatNumber(totals.outputTokens)}</TableCell>
            <TableCell className="text-right">{formatCurrency(totals.outputTokensCost, { significantFigures: 2 })}</TableCell>
          </TableRow>
          {totals.cachedReadTokens > 0 && (
            <TableRow>
              <TableCell className="flex flex-row items-center gap-1">
                <span>Cached Read</span>
                <InfoTooltip>
                  The number of tokens read from the prompt cache. This improves performance by avoiding re-processing
                  the same prompt.
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
                  The number of tokens written to the prompt cache. This improves performance by avoiding re-processing
                  the same prompt.
                </InfoTooltip>
              </TableCell>
              <TableCell className="text-right">{formatNumber(totals.cachedWriteTokens)}</TableCell>
              <TableCell className="text-right">
                {formatCurrency(totals.cachedWriteTokensCost, { significantFigures: 2 })}
              </TableCell>
            </TableRow>
          ) : undefined}
        </TableBody>
        <TableFooter className="overflow-clip rounded-b-md">
          <TableRow>
            <TableCell>Total</TableCell>
            <TableCell className="text-right">{formatNumber(totalTokens)}</TableCell>
            <TableCell className="text-right">{formatCurrency(totals.totalCost, { significantFigures: 2 })}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

