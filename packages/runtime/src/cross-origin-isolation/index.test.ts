import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  apiHeaders,
  applyApiHeaders,
  applyDocumentHeaders,
  applySubresourceHeaders,
  documentHeaders,
  inspectCrossOriginIsolation,
  subresourceHeaders,
} from '#cross-origin-isolation/index.js';

describe('canonical header constants', () => {
  it('documentHeaders should contain COOP, COEP require-corp, CORP same-origin', () => {
    expect(documentHeaders).toEqual({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
  });

  it('apiHeaders should advertise CORP cross-origin', () => {
    expect(apiHeaders).toEqual({ 'Cross-Origin-Resource-Policy': 'cross-origin' });
  });

  it('subresourceHeaders should advertise CORP same-origin', () => {
    expect(subresourceHeaders).toEqual({ 'Cross-Origin-Resource-Policy': 'same-origin' });
  });

  it('should be frozen so consumers cannot mutate canonical values', () => {
    expect(Object.isFrozen(documentHeaders)).toBe(true);
    expect(Object.isFrozen(apiHeaders)).toBe(true);
    expect(Object.isFrozen(subresourceHeaders)).toBe(true);
  });
});

describe('applyDocumentHeaders', () => {
  it('should set all three headers on a Headers instance', () => {
    const target = new Headers();
    applyDocumentHeaders(target);
    expect(target.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(target.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(target.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('should set all three headers on a plain record', () => {
    const target: Record<string, string> = {};
    applyDocumentHeaders(target);
    expect(target).toEqual({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
  });

  it('should override existing values', () => {
    const target = new Headers({ 'Cross-Origin-Opener-Policy': 'unsafe-none' });
    applyDocumentHeaders(target);
    expect(target.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });
});

describe('applyApiHeaders', () => {
  it('should set CORP cross-origin on a Headers instance', () => {
    const target = new Headers();
    applyApiHeaders(target);
    expect(target.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });

  it('should not set COOP or COEP (those belong to the document only)', () => {
    const target = new Headers();
    applyApiHeaders(target);
    expect(target.get('Cross-Origin-Opener-Policy')).toBeNull();
    expect(target.get('Cross-Origin-Embedder-Policy')).toBeNull();
  });
});

describe('applySubresourceHeaders', () => {
  it('should set CORP same-origin on a Headers instance', () => {
    const target = new Headers();
    applySubresourceHeaders(target);
    expect(target.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });
});
