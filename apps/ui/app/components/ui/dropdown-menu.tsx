import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import { cn } from '#utils/ui.utils.js';
import { Switch } from '#components/ui/switch.js';
import { Slider } from '#components/ui/slider.js';
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group.js';
import { ComboBoxResponsive } from '#components/ui/combobox-responsive.js';
import { Button } from '#components/ui/button.js';

function DropdownMenu({ ...properties }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>): React.JSX.Element {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...properties} />;
}

function DropdownMenuPortal({
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>): React.JSX.Element {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...properties} />;
}

function DropdownMenuTrigger({
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>): React.JSX.Element {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...properties} />;
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...properties}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>): React.JSX.Element {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...properties} />;
}

function DropdownMenuItem({
  className,
  isInset,
  variant = 'default',
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  readonly isInset?: boolean;
  readonly variant?: 'default' | 'destructive';
}): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={isInset}
      data-variant={variant}
      className={cn(
        "focus:text-accent-foreground relative flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm outline-hidden select-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:!text-destructive",
        className,
      )}
      {...properties}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "focus:text-accent-foreground relative flex h-8 cursor-pointer items-center gap-2 rounded-sm pr-2 pl-8 text-sm outline-hidden select-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      {...properties}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>): React.JSX.Element {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...properties} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "focus:text-accent-foreground relative flex h-8 cursor-pointer items-center gap-2 rounded-sm pr-2 pl-8 text-sm outline-hidden select-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...properties}
    >
      <span
        data-slot="dropdown-menu-radio-item-indicator"
        className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuSwitchItem({
  className,
  children,
  isChecked,
  onIsCheckedChange,
  ...properties
}: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.Item>, 'onSelect'> & {
  readonly isChecked: boolean;
  readonly onIsCheckedChange?: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-switch-item"
      className={cn(
        'focus:text-accent-foreground relative flex h-8 cursor-pointer items-center justify-between gap-2 rounded-sm px-2 text-sm outline-hidden select-none focus:bg-accent data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      onSelect={(event) => {
        event.preventDefault();
        onIsCheckedChange?.(!isChecked);
      }}
      {...properties}
    >
      <span
        className={cn(
          'flex items-center gap-2',
          "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
        )}
      >
        {children}
      </span>
      <Switch
        className="data-[state=unchecked]:bg-muted-foreground!"
        checked={isChecked}
        onCheckedChange={onIsCheckedChange}
      />
    </DropdownMenuPrimitive.Item>
  );
}

type DropdownMenuSliderItemProperties = {
  readonly className?: string;
  readonly children: React.ReactNode;
  readonly value: number;
  readonly onValueChange?: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly infoTooltip?: React.ReactNode;
  readonly formatValue?: (value: number) => string;
};

function DropdownMenuSliderItem({
  className,
  children,
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  infoTooltip,
  formatValue,
}: DropdownMenuSliderItemProperties): React.JSX.Element {
  const handleValueChange = React.useCallback(
    (values: number[]) => {
      const newValue = values[0];
      if (newValue !== undefined) {
        onValueChange?.(newValue);
      }
    },
    [onValueChange],
  );

  const displayValue = formatValue ? formatValue(value) : `${value}`;

  return (
    <div
      data-slot="dropdown-menu-slider-item"
      className={cn('px-2 py-2', className)}
      // Prevent dropdown from closing when interacting with slider
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span
          className={cn(
            'flex items-center gap-2 text-sm',
            "[&_svg]:pointer-events-none [&_svg]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
          )}
        >
          {children}
          {infoTooltip}
        </span>
        <span className="text-xs text-muted-foreground">{displayValue}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} className="w-full" onValueChange={handleValueChange} />
    </div>
  );
}

type ToggleOption<T extends string> = {
  value: T;
  label: React.ReactNode;
  ariaLabel?: string;
};

type DropdownMenuToggleGroupItemProperties<T extends string> = {
  readonly className?: string;
  readonly children: React.ReactNode;
  readonly infoTooltip?: React.ReactNode;
  readonly value: T;
  readonly options: Array<ToggleOption<T>>;
  readonly onValueChange?: (value: T) => void;
};

function DropdownMenuToggleGroupItem<T extends string>({
  className,
  children,
  infoTooltip,
  value,
  options,
  onValueChange,
}: DropdownMenuToggleGroupItemProperties<T>): React.JSX.Element {
  const handleValueChange = React.useCallback(
    (newValue: string) => {
      if (newValue) {
        onValueChange?.(newValue as T);
      }
    },
    [onValueChange],
  );

  return (
    <div
      data-slot="dropdown-menu-toggle-group-item"
      className={cn('flex items-center justify-between px-2 py-1.5', className)}
      // Prevent dropdown from closing when interacting with toggle group
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <span
        className={cn(
          'flex items-center gap-2 text-sm',
          "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        )}
      >
        {children}
        {infoTooltip}
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        value={value}
        className="font-semibold"
        onValueChange={handleValueChange}
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.ariaLabel ?? option.value}
            className="h-7 flex-1"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function DropdownMenuLabel({
  className,
  isInset,
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  readonly isInset?: boolean;
}): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={isInset}
      className={cn('px-2 py-1 text-xs font-medium text-muted-foreground data-[inset]:pl-8', className)}
      {...properties}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...properties}
    />
  );
}

function DropdownMenuShortcut({ className, ...properties }: React.ComponentProps<'span'>): React.JSX.Element {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...properties}
    />
  );
}

function DropdownMenuSub({ ...properties }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>): React.JSX.Element {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...properties} />;
}

function DropdownMenuSubTrigger({
  className,
  isInset,
  children,
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  readonly isInset?: boolean;
}): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={isInset}
      className={cn(
        'focus:text-accent-foreground data-[state=open]:text-accent-foreground flex h-8 cursor-pointer items-center rounded-sm px-2 text-sm outline-hidden select-none focus:bg-accent data-inset:pl-8 data-[state=open]:bg-accent [&_svg]:text-muted-foreground',
        className,
      )}
      {...properties}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...properties
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        'shadow-lg z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
        className,
      )}
      {...properties}
    />
  );
}

type DropdownMenuSelectItemProperties<T> = {
  readonly className?: string;
  readonly children: React.ReactNode;
  readonly infoTooltip?: React.ReactNode;
  readonly value: T;
  readonly options: T[];
  readonly getOptionValue: (option: T) => string;
  readonly getOptionLabel: (option: T) => string;
  readonly onValueChange?: (value: string) => void;
  readonly title?: string;
  readonly description?: string;
};

function DropdownMenuSelectItem<T>({
  className,
  children,
  infoTooltip,
  value,
  options,
  getOptionValue,
  getOptionLabel,
  onValueChange,
  title = 'Select option',
  description = 'Choose from available options',
}: DropdownMenuSelectItemProperties<T>): React.JSX.Element {
  const groupedItems = React.useMemo(
    () => [
      {
        name: '',
        items: options,
      },
    ],
    [options],
  );

  const renderLabel = React.useCallback(
    (item: T, selectedItem: T | undefined) => {
      const isSelected = selectedItem && getOptionValue(item) === getOptionValue(selectedItem);
      return (
        <span className="flex w-full items-center justify-between">
          <span>{getOptionLabel(item)}</span>
          {isSelected ? <CheckIcon className="size-4" /> : null}
        </span>
      );
    },
    [getOptionLabel, getOptionValue],
  );

  return (
    <div
      data-slot="dropdown-menu-select-item"
      className={cn('flex items-center justify-between px-2 py-1.5', className)}
      // Prevent parent dropdown from closing when interacting with select
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <span
        className={cn(
          'flex items-center gap-2 text-sm',
          "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
        )}
      >
        {children}
        {infoTooltip}
      </span>
      <ComboBoxResponsive
        isNested
        groupedItems={groupedItems}
        defaultValue={value}
        getValue={getOptionValue}
        renderLabel={renderLabel}
        title={title}
        description={description}
        isSearchEnabled={false}
        popoverProperties={{
          align: 'end',
          side: 'bottom',
          sideOffset: 4,
        }}
        onSelect={onValueChange}
      >
        <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" role="combobox">
          {getOptionLabel(value)}
          <ChevronDownIcon className="size-3 opacity-50" />
        </Button>
      </ComboBoxResponsive>
    </div>
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSwitchItem,
  DropdownMenuSliderItem,
  DropdownMenuSelectItem,
  DropdownMenuToggleGroupItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
