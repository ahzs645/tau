import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { tauEditorPanelDragMime, tauViewerPanelDragMime, tauFileDragMime } from '@taucad/types/constants';

function basename(filePath: string): string {
  const segments = filePath.split('/');
  return segments.at(-1) ?? filePath;
}

function isDirectory(filePath: string): boolean {
  return filePath.endsWith('/');
}

// eslint-disable-next-line @typescript-eslint/naming-convention -- Tiptap extensions are PascalCase by convention
export const ChatInputDropHandler = Extension.create({
  name: 'chatInputDropHandler',

  addProseMirrorPlugins() {
    const { schema } = this.editor;

    return [
      new Plugin({
        key: new PluginKey('chatInputDropHandler'),
        props: {
          handleDrop(view, event) {
            if (!event.dataTransfer) {
              return false;
            }

            const editorData = event.dataTransfer.getData(tauEditorPanelDragMime);
            const viewerData = event.dataTransfer.getData(tauViewerPanelDragMime);
            const fileData = event.dataTransfer.getData(tauFileDragMime);

            let filePaths: string[] = [];

            if (editorData) {
              try {
                const parsed = JSON.parse(editorData) as { filePath: string };
                filePaths = [parsed.filePath];
              } catch {
                return false;
              }
            } else if (viewerData) {
              try {
                const parsed = JSON.parse(viewerData) as { entryFile: string };
                filePaths = [parsed.entryFile];
              } catch {
                return false;
              }
            } else if (fileData) {
              try {
                filePaths = JSON.parse(fileData) as string[];
              } catch {
                return false;
              }
            }

            if (filePaths.length === 0) {
              return false;
            }

            event.preventDefault();

            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!pos) {
              return false;
            }

            const contextChipType = schema.nodes['contextChip'];
            if (!contextChipType) {
              return false;
            }

            const { tr } = view.state;
            let insertPos = pos.pos;

            for (const filePath of filePaths) {
              const node = contextChipType.create({
                id: filePath,
                label: basename(filePath),
                chipType: isDirectory(filePath) ? 'folder' : 'file',
                path: filePath,
              });
              tr.insert(insertPos, node);
              insertPos += node.nodeSize;
            }

            view.dispatch(tr);
            return true;
          },
        },
      }),
    ];
  },
});
