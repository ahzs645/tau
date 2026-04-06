import { describe, it, expect, beforeEach } from 'vitest';
import { MountTable } from '#mount-table.js';
import { FileService } from '#file-service.js';
import { ProviderRegistry } from '#provider-registry.js';
import { ResourceQueue } from '#resource-queue.js';
import { DirectoryTreeCache } from '#directory-tree-cache.js';
import { ChangeEventBus } from '#change-event-bus.js';
import { createMemoryProvider } from '#providers/memory-provider.js';
import type { ChangeEvent, FileSystemProvider } from '#types.js';

async function createMountedFileService() {
  const rootProvider = await createMemoryProvider();
  const nodeModulesProvider = await createMemoryProvider();

  const mountTable = new MountTable();
  mountTable.mount('/', rootProvider, { backend: 'memory' });
  mountTable.mount('/node_modules', nodeModulesProvider, { backend: 'memory' });

  const providerRegistry = new ProviderRegistry();

  const resourceQueue = new ResourceQueue();
  const treeCache = new DirectoryTreeCache();
  const eventBus = new ChangeEventBus();

  const service = new FileService({
    providerRegistry,
    resourceQueue,
    treeCache,
    eventBus,
    mountTable,
  });

  return { service, rootProvider, nodeModulesProvider, eventBus, mountTable };
}

describe('MountTable integration', () => {
  let service: FileService;
  let rootProvider: FileSystemProvider;
  let nodeModulesProvider: FileSystemProvider;
  let eventBus: ChangeEventBus;

  beforeEach(async () => {
    const context = await createMountedFileService();
    service = context.service;
    rootProvider = context.rootProvider;
    nodeModulesProvider = context.nodeModulesProvider;
    eventBus = context.eventBus;
  });

  // -------------------------------------------------------------------------
  // Multi-mount routing
  // -------------------------------------------------------------------------

  describe('multi-mount routing', () => {
    it('should route readFile to root mount for project files', async () => {
      await rootProvider.writeFile('/src/main.ts', 'hello');
      const content = await service.readFile('/src/main.ts', 'utf8');
      expect(content).toBe('hello');
    });

    it('should route readFile to node_modules mount', async () => {
      await nodeModulesProvider.writeFile('/lodash/index.js', 'module.exports = {}');
      const content = await service.readFile('/node_modules/lodash/index.js', 'utf8');
      expect(content).toBe('module.exports = {}');
    });

    it('should route writeFile to correct provider based on path', async () => {
      await service.writeFile('/src/app.ts', 'app code');
      await service.writeFile('/node_modules/react/index.js', 'react');

      expect(await rootProvider.readFile('/src/app.ts', 'utf8')).toBe('app code');
      expect(await nodeModulesProvider.readFile('/react/index.js', 'utf8')).toBe('react');
    });

    it('should route exists to correct provider', async () => {
      await rootProvider.writeFile('/project.json', '{}');
      await nodeModulesProvider.writeFile('/pkg/index.js', 'x');

      expect(await service.exists('/project.json')).toBe(true);
      expect(await service.exists('/node_modules/pkg/index.js')).toBe(true);
      expect(await service.exists('/node_modules/missing.js')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // readdir merge
  // -------------------------------------------------------------------------

  describe('readdir merge', () => {
    it('should inject node_modules as synthetic directory in root readdir', async () => {
      await rootProvider.writeFile('/src/main.ts', 'x');
      const entries = await service.readdir('/');
      expect(entries).toContain('src');
      expect(entries).toContain('node_modules');
    });

    it('should not duplicate node_modules if root provider also has it', async () => {
      await rootProvider.mkdir('/node_modules');
      await rootProvider.writeFile('/src/main.ts', 'x');
      const entries = await service.readdir('/');
      const nmCount = entries.filter((entry) => entry === 'node_modules').length;
      expect(nmCount).toBe(1);
    });

    it('should merge synthetic entries in readDirectory tree nodes', async () => {
      await rootProvider.writeFile('/main.ts', 'x');
      const nodes = await service.readDirectory('/');
      const nmNode = nodes.find((n) => n.name === 'node_modules');
      expect(nmNode).toBeDefined();
      expect(nmNode!.children).toEqual([]);
    });

    it('should only query node_modules provider for /node_modules/ paths', async () => {
      await nodeModulesProvider.writeFile('/lodash/index.js', 'x');
      const entries = await service.readdir('/node_modules');
      expect(entries).toContain('lodash');
    });
  });

  // -------------------------------------------------------------------------
  // Cross-mount operations
  // -------------------------------------------------------------------------

  describe('cross-mount operations', () => {
    it('should perform cross-mount rename as copy+delete', async () => {
      await rootProvider.writeFile('/temp.js', 'temp content');
      await service.rename('/temp.js', '/node_modules/temp.js');

      expect(await rootProvider.exists('/temp.js')).toBe(false);
      expect(await nodeModulesProvider.readFile('/temp.js', 'utf8')).toBe('temp content');
    });

    it('should handle same-mount rename normally', async () => {
      await rootProvider.writeFile('/old.ts', 'code');
      await service.rename('/old.ts', '/new.ts');

      expect(await rootProvider.exists('/old.ts')).toBe(false);
      expect(await rootProvider.readFile('/new.ts', 'utf8')).toBe('code');
    });

    it('should duplicate files across mount boundaries', async () => {
      await rootProvider.writeFile('/src/util.ts', 'util code');
      await service.duplicateFile('/src/util.ts', '/node_modules/util.ts');

      expect(await rootProvider.readFile('/src/util.ts', 'utf8')).toBe('util code');
      expect(await nodeModulesProvider.readFile('/util.ts', 'utf8')).toBe('util code');
    });
  });

  // -------------------------------------------------------------------------
  // Event propagation
  // -------------------------------------------------------------------------

  describe('event propagation', () => {
    it('should emit fileWritten with virtual absolute path for root writes', async () => {
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => {
        events.push(event);
      });

      await service.writeFile('/src/main.ts', 'code');
      const writeEvent = events.find(
        (event) => event.type === 'fileWritten' && 'path' in event && event.path === '/src/main.ts',
      );
      expect(writeEvent).toBeDefined();
    });

    it('should emit fileWritten with virtual absolute path for node_modules writes', async () => {
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => {
        events.push(event);
      });

      await service.writeFile('/node_modules/lodash/index.js', 'x');
      const writeEvent = events.find(
        (event) => event.type === 'fileWritten' && 'path' in event && event.path === '/node_modules/lodash/index.js',
      );
      expect(writeEvent).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Cache and tree coherence
  // -------------------------------------------------------------------------

  describe('cache and tree coherence', () => {
    it('should cache readDirectory per virtual path across mounts', async () => {
      await rootProvider.writeFile('/main.ts', 'x');
      const first = await service.readDirectory('/');
      const second = await service.readDirectory('/');
      expect(first).toEqual(second);
    });

    it('should collect directory stats from mounted provider', async () => {
      await rootProvider.writeFile('/src/a.ts', 'aaa');
      await rootProvider.writeFile('/src/b.ts', 'bb');
      const stats = await service.getDirectoryStat('/src');
      expect(stats).toHaveLength(2);
      const paths = stats.map((s) => s.path).sort();
      expect(paths).toEqual(['a.ts', 'b.ts']);
    });
  });

  // -------------------------------------------------------------------------
  // Backward compatibility
  // -------------------------------------------------------------------------

  describe('single mount', () => {
    it('should work with only a root mount', async () => {
      const providerRegistry = new ProviderRegistry();
      const provider = await providerRegistry.createMountProvider('memory');
      const mt = new MountTable();
      mt.mount('/', provider, { backend: 'memory' });

      const svc = new FileService({
        providerRegistry,
        resourceQueue: new ResourceQueue(),
        treeCache: new DirectoryTreeCache(),
        eventBus: new ChangeEventBus(),
        mountTable: mt,
      });

      await svc.writeFile('/test.txt', 'hello');
      const content = await svc.readFile('/test.txt', 'utf8');
      expect(content).toBe('hello');
    });
  });

  // -------------------------------------------------------------------------
  // Dynamic mount routing (domain-agnostic mount / unmount)
  // -------------------------------------------------------------------------

  describe('dynamic mount routing', () => {
    it('should mount a path prefix on the specified backend', async () => {
      await service.mount('/projects/proj_A', 'memory', { preservePath: true });
      const exists = await service.exists('/projects/proj_A');
      expect(exists).toBeDefined();
    });

    it('should route reads/writes to the mounted provider for mounted paths', async () => {
      await service.mount('/projects/proj_A', 'memory', { preservePath: true });
      await service.writeFile('/projects/proj_A/main.ts', 'project A code');
      const content = await service.readFile('/projects/proj_A/main.ts', 'utf8');
      expect(content).toBe('project A code');

      // Verify the file is NOT on the root provider
      expect(await rootProvider.exists('/projects/proj_A/main.ts')).toBe(false);
    });

    it('should route non-mounted paths to the root provider', async () => {
      await service.mount('/projects/proj_A', 'memory', { preservePath: true });
      await service.writeFile('/config.json', '{}');
      expect(await rootProvider.readFile('/config.json', 'utf8')).toBe('{}');
    });

    it('should unmount a prefix and fall through to root', async () => {
      await service.mount('/projects/proj_B', 'memory', { preservePath: true });
      await service.writeFile('/projects/proj_B/app.ts', 'app code');

      service.unmount('/projects/proj_B');

      // After unmount, the path falls through to root provider, which doesn't have the file
      expect(await service.exists('/projects/proj_B/app.ts')).toBe(false);
    });

    it('should handle multiple simultaneous mounts on different prefixes', async () => {
      await service.mount('/projects/proj_X', 'memory', { preservePath: true });
      await service.mount('/projects/proj_Y', 'memory', { preservePath: true });

      await service.writeFile('/projects/proj_X/x.ts', 'X');
      await service.writeFile('/projects/proj_Y/y.ts', 'Y');

      expect(await service.readFile('/projects/proj_X/x.ts', 'utf8')).toBe('X');
      expect(await service.readFile('/projects/proj_Y/y.ts', 'utf8')).toBe('Y');

      // Cross-isolation: project X file not visible under project Y
      expect(await service.exists('/projects/proj_Y/x.ts')).toBe(false);
    });

    it('should emit correct backend in events for mounted paths', async () => {
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => {
        events.push(event);
      });

      await service.mount('/projects/proj_C', 'memory', { preservePath: true });
      await service.writeFile('/projects/proj_C/main.ts', 'code');

      const writeEvent = events.find(
        (event) => event.type === 'fileWritten' && 'path' in event && event.path === '/projects/proj_C/main.ts',
      );
      expect(writeEvent).toBeDefined();
      expect(writeEvent!.backend).toBe('memory');
    });

    it('should emit correct backend in events for root paths', async () => {
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => {
        events.push(event);
      });

      await service.mount('/projects/proj_D', 'memory', { preservePath: true });
      await service.writeFile('/root-file.txt', 'root content');

      const writeEvent = events.find(
        (event) => event.type === 'fileWritten' && 'path' in event && event.path === '/root-file.txt',
      );
      expect(writeEvent).toBeDefined();
      expect(writeEvent!.backend).toBe('memory');
    });

    it('should isolate project mount from root mount', async () => {
      const providerRegistry = new ProviderRegistry();
      const rootProvider = await providerRegistry.createMountProvider('memory');

      const projectMountTable = new MountTable();
      projectMountTable.mount('/', rootProvider, { backend: 'memory' });
      const projectEventBus = new ChangeEventBus();

      const projectService = new FileService({
        providerRegistry,
        resourceQueue: new ResourceQueue(),
        treeCache: new DirectoryTreeCache(),
        eventBus: projectEventBus,
        mountTable: projectMountTable,
      });

      await projectService.mount('/projects/proj_E', 'memory', { preservePath: true });

      await projectService.writeFile('/projects/proj_E/test.ts', 'hello');
      expect(await projectService.readFile('/projects/proj_E/test.ts', 'utf8')).toBe('hello');

      expect(await projectService.exists('/test.ts')).toBe(false);
    });

    it('should dispose the mount provider on unmount', async () => {
      await service.mount('/projects/proj_F', 'memory', { preservePath: true });
      await service.writeFile('/projects/proj_F/test.ts', 'test');

      // Verify the file exists before unmount
      expect(await service.exists('/projects/proj_F/test.ts')).toBe(true);

      service.unmount('/projects/proj_F');

      // After unmount, the path falls through to root — file is gone
      expect(await service.exists('/projects/proj_F/test.ts')).toBe(false);
    });

    it('should pass full path to provider when mount uses preservePath', async () => {
      await service.mount('/projects/proj_G', 'memory', { preservePath: true });

      await service.writeFile('/projects/proj_G/main.ts', 'code');

      const content = await service.readFile('/projects/proj_G/main.ts', 'utf8');
      expect(content).toBe('code');

      const entries = await service.readdir('/projects/proj_G');
      expect(entries).toContain('main.ts');
    });
  });
});
