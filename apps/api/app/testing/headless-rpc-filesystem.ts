import type { RuntimeFileSystem } from '@taucad/runtime';
import type { RpcFileSystem, RpcFileStat } from '@taucad/chat/rpc';

/**
 * Adapts a RuntimeFileSystem (e.g. fromMemoryFS()) to the RpcFileSystem interface.
 */
export function createHeadlessRpcFileSystem(fs: RuntimeFileSystem): RpcFileSystem {
  return {
    async readFile(path: string): Promise<string> {
      return fs.readFile(path, 'utf8');
    },
    async writeFile(path: string, content: string): Promise<void> {
      await fs.writeFile(path, content);
    },
    async writeBinaryFile(path: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
      await fs.writeFile(path, new Uint8Array(data.buffer));
    },
    async deleteFile(path: string): Promise<void> {
      await fs.unlink(path);
    },
    async readdir(
      path: string,
    ): Promise<Array<{ name: string; type: 'file' | 'directory'; size: number; modifiedAt?: string }>> {
      const names = await fs.readdir(path);
      const entries: Array<{ name: string; type: 'file' | 'directory'; size: number; modifiedAt?: string }> = [];

      for (const name of names) {
        const fullPath = path ? `${path}/${name}` : name;
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential stat calls
          const info = await fs.stat(fullPath);
          entries.push({
            name,
            type: info.type === 'dir' ? 'directory' : 'file',
            size: info.size,
            modifiedAt: new Date(info.mtimeMs).toISOString(),
          });
        } catch {
          entries.push({ name, type: 'file', size: 0 });
        }
      }

      return entries;
    },
    async exists(path: string): Promise<boolean> {
      return fs.exists(path);
    },
    async appendFile(path: string, content: string): Promise<void> {
      let existing = '';
      try {
        existing = await fs.readFile(path, 'utf8');
      } catch {
        // File doesn't exist yet — will be created
      }

      await fs.writeFile(path, existing + content);
    },
    async editFile(
      path: string,
      oldString: string,
      newString: string,
      replaceAll?: boolean,
    ): Promise<{ occurrences: number }> {
      const content = await fs.readFile(path, 'utf8');

      let updated: string;
      let occurrences: number;

      if (replaceAll) {
        occurrences = content.split(oldString).length - 1;
        updated = occurrences > 0 ? content.replaceAll(oldString, newString) : content;
      } else {
        occurrences = content.includes(oldString) ? 1 : 0;
        updated = occurrences > 0 ? content.replace(oldString, newString) : content;
      }

      if (occurrences === 0) {
        throw new Error(`String not found in ${path}`);
      }

      await fs.writeFile(path, updated);
      return { occurrences };
    },
    async stat(path: string): Promise<RpcFileStat> {
      const info = await fs.stat(path);
      const isoDate = new Date(info.mtimeMs).toISOString();
      return {
        size: info.size,
        isDirectory: info.type === 'dir',
        createdAt: isoDate,
        modifiedAt: isoDate,
      };
    },
  };
}
