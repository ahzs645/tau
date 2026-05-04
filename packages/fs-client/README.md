# @taucad/fs-client

Client-side filesystem facades for Tau: `FileContentService`, `FileTreeService`, `WorkerChangeChannel`, path resolution, and related helpers.

Depends on `@taucad/filesystem` for the core types and primitives (`BoundedFileCache`, `FileSystemObserverBridge`, `FileTreeNode`, etc.).

## Entry points

Import from subpaths (no package root barrel), for example:

```typescript
import { FileContentService } from '@taucad/fs-client/file-content-service';
import { FileTreeService } from '@taucad/fs-client/file-tree-service';
```

See `package.json` `exports` for the full list.
