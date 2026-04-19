import { describe, it, expect } from 'vitest';
import { DirectoryTreeCache } from '#directory-tree-cache.js';
import type { TreeEntry } from '#types.js';

function entry(name: string): Map<string, TreeEntry> {
  return new Map([[name, { name, type: 'file', size: 0, mtimeMs: 0 }]]);
}

describe('DirectoryTreeCache', () => {
  describe('invalidateAncestors', () => {
    it('should invalidate all ancestors up to root', () => {
      const cache = new DirectoryTreeCache();
      cache.set('/', entry('root'));
      cache.set('/a', entry('a'));
      cache.set('/a/b', entry('b'));
      cache.set('/a/b/c', entry('c'));
      cache.set('/a/b/c/d', entry('d'));

      cache.invalidateAncestors('/a/b/c/d');

      expect(cache.get('/')).toBeUndefined();
      expect(cache.get('/a')).toBeUndefined();
      expect(cache.get('/a/b')).toBeUndefined();
      expect(cache.get('/a/b/c')).toBeUndefined();
      expect(cache.get('/a/b/c/d')).toBeUndefined();
    });

    it('should not invalidate sibling directories', () => {
      const cache = new DirectoryTreeCache();
      cache.set('/a', entry('a'));
      cache.set('/a/b', entry('b'));
      cache.set('/a/x', entry('x'));

      cache.invalidateAncestors('/a/b');

      expect(cache.get('/a')).toBeUndefined();
      expect(cache.get('/a/b')).toBeUndefined();
      expect(cache.get('/a/x')).toBeDefined();
    });

    it('should handle root-level paths', () => {
      const cache = new DirectoryTreeCache();
      cache.set('/', entry('root'));
      cache.set('/foo', entry('foo'));

      cache.invalidateAncestors('/foo');

      expect(cache.get('/')).toBeUndefined();
      expect(cache.get('/foo')).toBeUndefined();
    });
  });
});
