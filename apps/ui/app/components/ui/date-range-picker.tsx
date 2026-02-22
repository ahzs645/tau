import * as React from 'react';
import { subDays, format } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { Button } from '#components/ui/button.js';
import { Calendar } from '#components/ui/calendar.js';
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover.js';
import { cn } from '#utils/ui.utils.js';

export type DateRangePreset = {
  label: string;
  value: DateRange;
};

/**
 * Default presets for common date ranges.
 */
export const defaultDateRangePresets: DateRangePreset[] = [
  {
    label: 'Last 7 days',
    value: { from: subDays(new Date(), 7), to: new Date() },
  },
  {
    label: 'Last 30 days',
    value: { from: subDays(new Date(), 30), to: new Date() },
  },
  {
    label: 'Last 90 days',
    value: { from: subDays(new Date(), 90), to: new Date() },
  },
];

type DateRangePickerProps = {
  /**
   * Controlled value for the date range.
   */
  readonly value?: DateRange;
  /**
   * Callback when the date range changes.
   */
  readonly onChange?: (range: DateRange | undefined) => void;
  /**
   * Preset date ranges to show as quick selection buttons.
   */
  readonly presets?: DateRangePreset[];
  /**
   * Whether to show presets. Defaults to false.
   */
  readonly withPresets?: boolean;
  /**
   * Placeholder text when no date is selected.
   */
  readonly placeholder?: string;
  /**
   * Additional class name for the trigger button.
   */
  readonly className?: string;
  /**
   * Alignment for the popover.
   */
  readonly align?: 'start' | 'center' | 'end';
  /**
   * Whether to disable the picker.
   */
  readonly isDisabled?: boolean;
};

export function DateRangePicker({
  value,
  onChange,
  presets = defaultDateRangePresets,
  withPresets = false,
  placeholder = 'Pick a date range',
  className,
  align = 'start',
  isDisabled = false,
}: DateRangePickerProps): React.JSX.Element {
  // Support both controlled and uncontrolled modes
  const [internalDate, setInternalDate] = React.useState<DateRange | undefined>(undefined);
  const date = value ?? internalDate;
  const setDate = onChange ?? setInternalDate;

  const handlePresetClick = (preset: DateRangePreset): void => {
    setDate(preset.value);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={isDisabled}
          className={cn('justify-start px-2.5 font-normal', !date && 'text-muted-foreground', className)}
        >
          <CalendarIcon className="mr-2 size-4" />
          {date?.from ? (
            date.to ? (
              <>
                {format(date.from, 'LLL dd, y')} - {format(date.to, 'LLL dd, y')}
              </>
            ) : (
              format(date.from, 'LLL dd, y')
            )
          ) : (
            <span>{placeholder}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align={align}>
        {withPresets && presets.length > 0 ? (
          <div className="flex flex-col gap-2 border-b p-3">
            <div className="flex flex-wrap gap-2">
              {presets.map((preset) => (
                <Button
                  key={preset.label}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    handlePresetClick(preset);
                  }}
                >
                  {preset.label}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => {
                  setDate(undefined);
                }}
              >
                Clear
              </Button>
            </div>
          </div>
        ) : undefined}
        <Calendar
          mode="range"
          defaultMonth={date?.from}
          selected={date}
          numberOfMonths={2}
          classNames={{
            root: 'w-full',
            months: 'relative flex w-full flex-col gap-4 md:flex-row',
          }}
          onSelect={setDate}
        />
      </PopoverContent>
    </Popover>
  );
}
