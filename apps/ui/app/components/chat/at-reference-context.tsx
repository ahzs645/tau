import { createContext, use, useMemo } from 'react';
import type { Chat } from '@taucad/chat';
import type { FileTreeService } from '#lib/file-tree-service.js';

type AtReferenceContextValue = {
  treeService: FileTreeService | undefined;
  chatsById: Map<string, Chat>;
};

const AtReferenceContext = createContext<AtReferenceContextValue>({
  treeService: undefined,
  chatsById: new Map(),
});

type AtReferenceProviderProps = {
  readonly treeService: FileTreeService | undefined;
  readonly chats: Chat[];
  readonly children: React.ReactNode;
};

export function AtReferenceProvider({ treeService, chats, children }: AtReferenceProviderProps): React.JSX.Element {
  const chatsById = useMemo(() => new Map(chats.map((c) => [c.id, c])), [chats]);
  const contextValue = useMemo(() => ({ treeService, chatsById }), [treeService, chatsById]);

  return <AtReferenceContext value={contextValue}>{children}</AtReferenceContext>;
}

export function useAtReferenceContext(): AtReferenceContextValue {
  return use(AtReferenceContext);
}
