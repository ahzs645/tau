import { createContext, use, useMemo } from 'react';
import type { FileEntry } from '@taucad/types';
import type { Chat } from '@taucad/chat';

type AtReferenceContextValue = {
  fileTree: Map<string, FileEntry>;
  chatsById: Map<string, Chat>;
};

const AtReferenceContext = createContext<AtReferenceContextValue>({
  fileTree: new Map(),
  chatsById: new Map(),
});

type AtReferenceProviderProps = {
  readonly fileTree: Map<string, FileEntry>;
  readonly chats: Chat[];
  readonly children: React.ReactNode;
};

export function AtReferenceProvider({ fileTree, chats, children }: AtReferenceProviderProps): React.JSX.Element {
  const chatsById = useMemo(() => new Map(chats.map((c) => [c.id, c])), [chats]);
  const contextValue = useMemo(() => ({ fileTree, chatsById }), [fileTree, chatsById]);

  return <AtReferenceContext value={contextValue}>{children}</AtReferenceContext>;
}

export function useAtReferenceContext(): AtReferenceContextValue {
  return use(AtReferenceContext);
}
