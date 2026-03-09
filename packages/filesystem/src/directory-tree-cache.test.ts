import { describe, it, expect, beforeEach } from 'vitest';
import { DirectoryTreeCache } from '#directory-tree-cache.js';
import type { TreeEntry } from '#types.js';

function makeEntry(name: string, type: 'file' | 'directory' = 'file'): TreeEntry {
  return { name, type, size: 0, mtimeMs: 0 };
}

function makeEntries(...names: string[]): Map<string, TreeEntry> {
  const m = new Map<string, TreeEntry>();
  for (const n of names) {
    m.set(n, makeEntry(n));
  }
  return m;
}

describe('DirectoryTreeCache', () => {
  let cache: DirectoryTreeCache;

  beforeEach(() => {
    cache = new DirectoryTreeCache();
  });

  describe('get/set basic operations', () => {
    it('should return undefined for missing path', () => {
      expect(cache.get('/foo')).toBeUndefined();
    });

    it('should return entries after set', () => {
      const entries = makeEntries('a.txt', 'b.txt');
      cache.set('/foo', entries);
      expect(cache.get('/foo')).toBe(entries);
    });

    it('should overwrite existing path on set', () => {
      cache.set('/foo', makeEntries('old.txt'));
      const entries = makeEntries('new.txt');
      cache.set('/foo', entries);
      expect(cache.get('/foo')).toBe(entries);
    });

    it('should store multiple directories independently', () => {
      const a = makeEntries('a1.txt');
      const b = makeEntries('b1.txt');
      cache.set('/a', a);
      cache.set('/b', b);
      expect(cache.get('/a')).toBe(a);
      expect(cache.get('/b')).toBe(b);
    });
  });

  describe('invalidate', () => {
    it('should remove a single directory', () => {
      cache.set('/foo', makeEntries('a.txt'));
      cache.invalidate('/foo');
      expect(cache.get('/foo')).toBeUndefined();
    });

    it('should not remove sibling directories', () => {
      cache.set('/foo', makeEntries('a.txt'));
      cache.set('/bar', makeEntries('b.txt'));
      cache.invalidate('/foo');
      expect(cache.get('/foo')).toBeUndefined();
      expect(cache.get('/bar')).toBeDefined();
    });

    it('should not remove parent or child directories', () => {
      cache.set('/parent', makeEntries('x.txt'));
      cache.set('/parent/child', makeEntries('y.txt'));
      cache.invalidate('/parent');
      expect(cache.get('/parent')).toBeUndefined();
      expect(cache.get('/parent/child')).toBeDefined();
    });
  });

  describe('invalidateSubtree', () => {
    it('should remove directory and all descendants', () => {
      cache.set('/foo', makeEntries('a.txt'));
      cache.set('/foo/bar', makeEntries('b.txt'));
      cache.set('/foo/bar/baz', makeEntries('c.txt'));
      cache.invalidateSubtree('/foo');
      expect(cache.get('/foo')).toBeUndefined();
      expect(cache.get('/foo/bar')).toBeUndefined();
      expect(cache.get('/foo/bar/baz')).toBeUndefined();
    });

    it('should not remove sibling trees', () => {
      cache.set('/foo/a', makeEntries('x.txt'));
      cache.set('/foo/b', makeEntries('y.txt'));
      cache.set('/bar', makeEntries('z.txt'));
      cache.invalidateSubtree('/foo');
      expect(cache.get('/foo/a')).toBeUndefined();
      expect(cache.get('/foo/b')).toBeUndefined();
      expect(cache.get('/bar')).toBeDefined();
    });

    it('should invalidate root subtree when path is /', () => {
      cache.set('/', makeEntries('root.txt'));
      cache.set('/foo', makeEntries('a.txt'));
      cache.set('/bar', makeEntries('b.txt'));
      cache.invalidateSubtree('/');
      expect(cache.get('/')).toBeUndefined();
      expect(cache.get('/foo')).toBeUndefined();
      expect(cache.get('/bar')).toBeUndefined();
    });

    it('should not remove parent when invalidating child subtree', () => {
      cache.set('/foo', makeEntries('a.txt'));
      cache.set('/foo/bar', makeEntries('b.txt'));
      cache.invalidateSubtree('/foo/bar');
      expect(cache.get('/foo')).toBeDefined();
      expect(cache.get('/foo/bar')).toBeUndefined();
    });
  });

  describe('path normalization', () => {
    it('should normalize leading slash (adds if missing)', () => {
      cache.set('foo', makeEntries('a.txt'));
      expect(cache.get('/foo')).toBeDefined();
      expect(cache.get('foo')).toBeDefined();
    });

    it('should normalize trailing slash (removes)', () => {
      cache.set('/foo', makeEntries('a.txt'));
      expect(cache.get('/foo/')).toBeDefined();
    });

    it('should handle root path', () => {
      cache.set('/', makeEntries('root.txt'));
      expect(cache.get('/')).toBeDefined();
      expect(cache.get('')).toBeDefined();
    });

    it('should use same normalization for set and get', () => {
      cache.set('foo/bar/', makeEntries('a.txt'));
      expect(cache.get('/foo/bar')).toBeDefined();
    });

    it('should use normalized path for invalidate', () => {
      cache.set('/foo', makeEntries('a.txt'));
      cache.invalidate('foo');
      expect(cache.get('/foo')).toBeUndefined();
    });

    it('should use normalized path for invalidateSubtree', () => {
      cache.set('/foo/bar', makeEntries('a.txt'));
      cache.invalidateSubtree('foo');
      expect(cache.get('/foo/bar')).toBeUndefined();
    });
  });

  describe('getFullTree', () => {
    it('should return the full cache', () => {
      cache.set('/a', makeEntries('x.txt'));
      cache.set('/b', makeEntries('y.txt'));
      const tree = cache.getFullTree();
      expect(tree.size).toBe(2);
      expect(tree.get('/a')).toBeDefined();
      expect(tree.get('/b')).toBeDefined();
    });

    it('should return empty map when cache is empty', () => {
      const tree = cache.getFullTree();
      expect(tree.size).toBe(0);
    });

    it('should return live reference (mutations affect cache)', () => {
      cache.set('/foo', makeEntries('a.txt'));
      const tree = cache.getFullTree();
      tree.delete('/foo');
      expect(cache.get('/foo')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      cache.set('/a', makeEntries('x.txt'));
      cache.set('/b', makeEntries('y.txt'));
      cache.clear();
      expect(cache.get('/a')).toBeUndefined();
      expect(cache.get('/b')).toBeUndefined();
      expect(cache.getFullTree().size).toBe(0);
    });

    it('should be idempotent', () => {
      cache.set('/foo', makeEntries('a.txt'));
      cache.clear();
      cache.clear();
      expect(cache.get('/foo')).toBeUndefined();
    });
  });
});
