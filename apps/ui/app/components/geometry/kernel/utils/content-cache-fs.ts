/**
 * Content-Cache-backed Emscripten FS Backend
 *
 * A lightweight custom Emscripten filesystem backend that serves reads directly
 * from the worker's existing fileContentCache. This avoids the need for a separate
 * ZenFS instance in the kernel worker and eliminates all file copying.
 *
 * Used by Emscripten-based kernels (OpenSCAD, potentially OpenCASCADE) to mount
 * project files at a specific path in the Emscripten virtual filesystem.
 *
 * @see Phase 5F of the Kernel Runtime Architecture plan
 */

/**
 * Minimal Emscripten FS types needed for the mount interface.
 * These match the Emscripten FS API without requiring the full Emscripten type definitions.
 */
type EmscriptenFSNode = {
  name: string;
  mode: number;
  parent: EmscriptenFSNode;
  mount: { opts: { root?: string } };
  node_ops?: EmscriptenNodeOps;
  stream_ops?: EmscriptenStreamOps;
};

type EmscriptenFSStream = {
  node: EmscriptenFSNode;
  position: number;
};

type EmscriptenNodeOps = {
  getattr(node: EmscriptenFSNode): { mode: number; size: number; atime: Date; mtime: Date; ctime: Date };
  lookup(parent: EmscriptenFSNode, name: string): EmscriptenFSNode;
  readdir(node: EmscriptenFSNode): string[];
};

type EmscriptenStreamOps = {
  read(
    stream: EmscriptenFSStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
};

type EmscriptenFS = {
  createNode(parent: EmscriptenFSNode, name: string, mode: number): EmscriptenFSNode;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Emscripten constant
  ErrnoError: new (errno: number) => Error;
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Emscripten constant
  FSNode: new (parent: EmscriptenFSNode, name: string, mode: number) => EmscriptenFSNode;
};

const S_IFDIR = 0o40000;
const S_IFREG = 0o100000;
const ENOENT = 44;

const textEncoder = new TextEncoder();

/**
 * Create a custom Emscripten FS backend backed by the worker's content cache.
 *
 * The backend is read-only: Emscripten kernels write output to MEMFS (the default
 * filesystem at /), while project files are served from this mount.
 *
 * @param contentCache - Read-only map of absolute paths to file contents
 * @param basePath - The base path to strip from absolute paths when resolving
 * @param emscriptenFS - The Emscripten FS module (instance.FS)
 * @returns An object suitable for FS.mount()
 */
export function createContentCacheFS(
  contentCache: ReadonlyMap<string, Uint8Array<ArrayBuffer> | string>,
  basePath: string,
  emscriptenFS: EmscriptenFS,
): { mount(mount: { opts: { root?: string } }): EmscriptenFSNode; node_ops: EmscriptenNodeOps; stream_ops: EmscriptenStreamOps } {
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;

  function resolveToAbsolute(relativePath: string): string {
    const cleaned = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    return `${normalizedBase}${cleaned}`;
  }

  function realPath(node: EmscriptenFSNode): string {
    const parts: string[] = [];
    let current = node;
    while (current.parent !== current) {
      parts.push(current.name);
      current = current.parent;
    }

    parts.reverse();
    return parts.join('/');
  }

  function isDirectory(relativePath: string): boolean {
    const prefix = resolveToAbsolute(relativePath);
    for (const key of contentCache.keys()) {
      if (key.startsWith(prefix) && key !== prefix) {
        return true;
      }
    }

    return false;
  }

  function getDirectoryEntries(relativePath: string): string[] {
    const prefix = resolveToAbsolute(relativePath);
    const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    const entries = new Set<string>();

    for (const key of contentCache.keys()) {
      if (key.startsWith(normalizedPrefix)) {
        const remaining = key.slice(normalizedPrefix.length);
        const firstSlash = remaining.indexOf('/');
        entries.add(firstSlash === -1 ? remaining : remaining.slice(0, firstSlash));
      }
    }

    return [...entries];
  }

  const now = new Date();

  const node_ops: EmscriptenNodeOps = {
    getattr(node) {
      const path = realPath(node);
      const absolutePath = resolveToAbsolute(path);
      const content = contentCache.get(absolutePath);

      if (content !== undefined) {
        const size = typeof content === 'string' ? textEncoder.encode(content).length : content.byteLength;
        return { mode: S_IFREG | 0o644, size, atime: now, mtime: now, ctime: now };
      }

      if (isDirectory(path) || path === '') {
        return { mode: S_IFDIR | 0o755, size: 4096, atime: now, mtime: now, ctime: now };
      }

      throw new emscriptenFS.ErrnoError(ENOENT);
    },

    lookup(parent, name) {
      const parentPath = realPath(parent);
      const childPath = parentPath ? `${parentPath}/${name}` : name;
      const absolutePath = resolveToAbsolute(childPath);
      const content = contentCache.get(absolutePath);

      if (content !== undefined) {
        const childNode = emscriptenFS.createNode(parent, name, S_IFREG | 0o644);
        childNode.node_ops = node_ops;
        childNode.stream_ops = stream_ops;
        return childNode;
      }

      if (isDirectory(childPath)) {
        const childNode = emscriptenFS.createNode(parent, name, S_IFDIR | 0o755);
        childNode.node_ops = node_ops;
        childNode.stream_ops = stream_ops;
        return childNode;
      }

      throw new emscriptenFS.ErrnoError(ENOENT);
    },

    readdir(node) {
      const path = realPath(node);
      return ['.', '..', ...getDirectoryEntries(path)];
    },
  };

  const stream_ops: EmscriptenStreamOps = {
    read(stream, buffer, offset, length, position) {
      const path = realPath(stream.node);
      const absolutePath = resolveToAbsolute(path);
      const content = contentCache.get(absolutePath);

      if (content === undefined) {
        throw new emscriptenFS.ErrnoError(ENOENT);
      }

      const data = typeof content === 'string' ? textEncoder.encode(content) : content;
      const available = Math.min(length, data.byteLength - position);

      if (available <= 0) {
        return 0;
      }

      buffer.set(data.subarray(position, position + available), offset);
      return available;
    },
  };

  return {
    mount(mount: { opts: { root?: string } }) {
      const root = new emscriptenFS.FSNode(
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Emscripten FS root node has no real parent
        undefined as unknown as EmscriptenFSNode,
        '/',
        S_IFDIR | 0o755,
      );
      root.parent = root;
      root.mount = mount;
      root.node_ops = node_ops;
      root.stream_ops = stream_ops;
      return root;
    },
    node_ops,
    stream_ops,
  };
}
