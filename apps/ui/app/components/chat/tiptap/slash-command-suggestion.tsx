import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { Extension } from '@tiptap/core';
import { Suggestion } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { Zap, BookOpen } from 'lucide-react';
import { cn } from '#utils/ui.utils.js';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '#components/ui/hover-card.js';
import type {
  SlashCommandItem,
  SuggestionPopupState,
  SuggestionRenderCallbacks,
} from '#components/chat/tiptap/suggestion-types.js';

const slashCommandPluginKey = new PluginKey('slashCommand');

export const defaultSkills: SlashCommandItem[] = [
  {
    id: 'create-policy',
    label: '/create-policy',
    description: 'Create or update policy documents',
    fullDescription:
      'Create or update policy documents in docs/policy/. Use when writing a new policy, updating an existing policy, reviewing policy structure, or when the user mentions policy docs, coding standards, or architectural decisions that should be documented as policy.',
    group: 'Skills',
  },
  {
    id: 'create-research',
    label: '/create-research',
    description: 'Create or update research documents',
    fullDescription:
      'Create or update research documents in docs/research/. Use when investigating a bug root cause, auditing code or configuration, comparing libraries or approaches, designing architecture, evaluating migration paths, or when the user mentions research, investigation, audit, analysis, or deep dive.',
    group: 'Skills',
  },
  {
    id: 'create-skill',
    label: '/create-skill',
    description: 'Create a new agent skill',
    fullDescription:
      'Guides users through creating effective Agent Skills for Cursor. Use when you want to create, write, or author a new skill, or asks about skill structure, best practices, or SKILL.md format.',
    group: 'Skills',
  },
  {
    id: 'repos',
    label: '/repos',
    description: 'Investigate dependency source code',
    fullDescription:
      'Investigate dependency source code and manage external repos via repos.yaml. Use when investigating how a library works internally, exploring dependency source, reading upstream code, debugging third-party behavior, adding a new dependency to track, or contributing to upstream forks.',
    group: 'Skills',
  },
  {
    id: 'adding-tools',
    label: '/adding-tools',
    description: 'Add new tools to the AI chat',
    fullDescription:
      'Add new tools to the AI chat system. Use when adding a chat tool, creating tool schemas, wiring backend tool handlers, or building tool UI components.',
    group: 'Skills',
  },
  {
    id: 'new-kernel',
    label: '/new-kernel',
    description: 'Add a new CAD kernel',
    fullDescription:
      'Add a new first-party CAD kernel to the @taucad/runtime plugin system. Use when adding a kernel, integrating a new CAD engine, implementing defineKernel, or wiring kernel factories, exports, presets, and UI catalog entries.',
    group: 'Skills',
  },
];

const defaultCommands: SlashCommandItem[] = [
  { id: 'plan', label: '/plan', description: 'Switch to Plan mode', group: 'Commands' },
  { id: 'compress', label: '/compress', description: 'Compress conversation context', group: 'Commands' },
];

export type SlashCommandOptions = {
  getItems?: (query: string) => SlashCommandItem[];
  renderCallbacks: SuggestionRenderCallbacks<SlashCommandItem>;
  onCommand?: (item: SlashCommandItem) => void;
};

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return {
      getItems: undefined,
      renderCallbacks: {
        onStateChange: () => undefined,
        keydownHandlerRef: { current: undefined },
      },
      onCommand: undefined,
    };
  },

  addProseMirrorPlugins() {
    const { getItems, renderCallbacks, onCommand } = this.options;

    const defaultGetItems = (query: string): SlashCommandItem[] => {
      const all = [...defaultSkills, ...defaultCommands];
      if (!query) {
        return all;
      }
      const q = query.toLowerCase();
      return all.filter((item) => item.label.toLowerCase().includes(q) || item.description.toLowerCase().includes(q));
    };

    const itemsFunction = getItems ?? defaultGetItems;

    return [
      // oxlint-disable-next-line new-cap -- Tiptap's Suggestion factory is PascalCase
      Suggestion<SlashCommandItem>({
        pluginKey: slashCommandPluginKey,
        editor: this.editor,
        char: '/',
        items: ({ query }) => itemsFunction(query),
        startOfLine: true,
        command: ({ editor, range, props }) => {
          const item = props as SlashCommandItem;
          if (item.group === 'Commands') {
            editor.chain().focus().deleteRange(range).run();
            onCommand?.(item);
            return;
          }

          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: 'contextChip',
              attrs: {
                id: item.id,
                label: item.label,
                chipType: 'skill',
              },
            })
            .insertContent(' ')
            .run();
        },
        render: () => ({
          onStart(properties) {
            renderCallbacks.onStateChange({
              query: properties.query,
              items: properties.items,
              command: properties.command as (item: SlashCommandItem) => void,
              clientRect: properties.clientRect ?? undefined,
            } as SuggestionPopupState<SlashCommandItem>);
          },
          onUpdate(properties) {
            renderCallbacks.onStateChange({
              query: properties.query,
              items: properties.items,
              command: properties.command as (item: SlashCommandItem) => void,
              clientRect: properties.clientRect ?? undefined,
            } as SuggestionPopupState<SlashCommandItem>);
          },
          onExit() {
            renderCallbacks.onStateChange(undefined);
          },
          onKeyDown({ event }) {
            return renderCallbacks.keydownHandlerRef.current?.(event) ?? false;
          },
        }),
      }),
    ];
  },
});

// --- Dropdown UI Component ---

const groupIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  Skills: BookOpen,
  Commands: Zap,
};

function SkillItemButton({
  item,
  globalIndex,
  isSelected,
  onSelect,
  onHover,
  buttonRef,
}: {
  readonly item: SlashCommandItem;
  readonly globalIndex: number;
  readonly isSelected: boolean;
  readonly onSelect: (index: number) => void;
  readonly onHover: (index: number) => void;
  // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- React ref callback signature requires null
  readonly buttonRef: (element: HTMLButtonElement | null) => void;
}): React.JSX.Element {
  const button = (
    <button
      ref={buttonRef}
      type='button'
      className={cn(
        'flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left',
        'hover:bg-accent hover:text-accent-foreground',
        isSelected && 'bg-accent text-accent-foreground',
      )}
      onClick={() => {
        onSelect(globalIndex);
      }}
      onMouseEnter={() => {
        onHover(globalIndex);
      }}
    >
      <span className='text-sm font-medium'>{item.label}</span>
      <span className='text-xs text-muted-foreground'>{item.description}</span>
    </button>
  );

  if (!item.fullDescription) {
    return button;
  }

  return (
    <HoverCard>
      <HoverCardTrigger asChild>{button}</HoverCardTrigger>
      <HoverCardContent side='right' align='start' sideOffset={12} alignOffset={-4} className='w-72'>
        <div className='space-y-2'>
          <div className='flex items-center gap-2'>
            <BookOpen className='size-4 shrink-0 text-muted-foreground' />
            <h4 className='text-sm font-semibold'>{item.label}</h4>
          </div>
          <p className='text-sm text-muted-foreground'>{item.fullDescription}</p>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export const SlashCommandDropdown = memo(function SlashCommandDropdown({
  state,
  keydownHandlerRef,
}: {
  readonly state: SuggestionPopupState<SlashCommandItem>;
  // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object
  readonly keydownHandlerRef: React.RefObject<((event: KeyboardEvent) => boolean) | undefined>;
}): React.JSX.Element | undefined {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemReferences = useRef<Map<number, HTMLButtonElement>>(new Map());

  const { items, command, clientRect } = state;

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useEffect(() => {
    const element = itemReferences.current.get(selectedIndex);
    element?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const selectItem = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) {
        command(item);
      }
    },
    [items, command],
  );

  useEffect(() => {
    keydownHandlerRef.current = (event: KeyboardEvent): boolean => {
      if (event.key === 'ArrowUp') {
        setSelectedIndex((previous) => (previous <= 0 ? items.length - 1 : previous - 1));
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelectedIndex((previous) => (previous >= items.length - 1 ? 0 : previous + 1));
        return true;
      }
      if (event.key === 'Enter') {
        selectItem(selectedIndex);
        return true;
      }
      if (event.key === 'Escape') {
        return true;
      }
      return false;
    };

    return () => {
      keydownHandlerRef.current = undefined;
    };
  }, [items, selectedIndex, selectItem, keydownHandlerRef]);

  const rect = clientRect?.();
  if (!rect) {
    return undefined;
  }

  const groups = new Map<string, { items: SlashCommandItem[]; startIndex: number }>();
  let currentIndex = 0;
  for (const item of items) {
    const existing = groups.get(item.group);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(item.group, { items: [item], startIndex: currentIndex });
    }
    currentIndex++;
  }

  return createPortal(
    <div
      className={cn(
        'fixed z-50 max-h-64 w-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
      )}
      style={{
        left: rect.left,
        top: rect.top - 8,
        transform: 'translateY(-100%)',
      }}
    >
      {items.length === 0 ? (
        <div className='px-2 py-1.5 text-xs text-muted-foreground'>No commands found</div>
      ) : (
        [...groups.entries()].map(([groupName, group]) => {
          const GroupIcon = groupIcons[groupName] ?? Zap;
          return (
            <div key={groupName}>
              <div className='flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground'>
                <GroupIcon className='size-3 shrink-0' />
                {groupName}
              </div>
              {group.items.map((item, itemIndex) => {
                const globalIndex = group.startIndex + itemIndex;
                return (
                  <SkillItemButton
                    key={item.id}
                    item={item}
                    globalIndex={globalIndex}
                    isSelected={globalIndex === selectedIndex}
                    onSelect={selectItem}
                    onHover={setSelectedIndex}
                    buttonRef={(element) => {
                      if (element) {
                        itemReferences.current.set(globalIndex, element);
                      } else {
                        itemReferences.current.delete(globalIndex);
                      }
                    }}
                  />
                );
              })}
            </div>
          );
        })
      )}
    </div>,
    document.body,
  );
});
