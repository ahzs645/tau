import { describe, expect, it } from 'vitest';
import { decodeParameters, encodeParameters, modelUrl, readGalleryLocation } from '#sharing/location.js';

describe('gallery links', () => {
  it('should preserve parameters and Unicode across the existing version-one codec', () => {
    const parameters = { width: 42.25, label: 'أحمد / 台', enabled: true, points: [1, 2], nested: { value: null } };
    expect(decodeParameters(encodeParameters(parameters))).toEqual(parameters);
    expect(decodeParameters('1.raw.eyJ3aWR0aCI6NDJ9')).toEqual({ width: 42 });
  });

  it.each([
    '/pendant-lamp',
    '/tau/pendant-lamp',
    '/playground?model=pendant-lamp',
    '/tau/playground?example=pendant-lamp',
    '/?model=pendant-lamp',
  ])('should open the same model from %s', (path) => {
    expect(readGalleryLocation(new URL(path, 'https://3dd.ahmadjalil.com'))).toMatchObject({
      modelId: 'pendant-lamp',
      isGallery: false,
      parameters: {},
    });
  });

  it('should keep a variant and parameter selection while removing legacy routing keys', () => {
    const url = modelUrl('pendant-lamp', {
      base: new URL('https://3dd.ahmadjalil.com/tau/playground?model=old&example=old&kiosk=true#view'),
      variantId: 'opencascade',
      parameters: { height: 150 },
    });
    expect(url.pathname).toBe('/pendant-lamp');
    expect(url.searchParams.has('model')).toBe(false);
    expect(url.searchParams.has('example')).toBe(false);
    expect(url.searchParams.get('kiosk')).toBe('true');
    expect(url.hash).toBe('#view');
    expect(readGalleryLocation(url)).toMatchObject({ variantId: 'opencascade', parameters: { height: 150 } });
  });

  it('should keep the selected model reachable when shared parameters are malformed', () => {
    const route = readGalleryLocation(new URL('https://3dd.ahmadjalil.com/gel-comb?p=broken'));
    expect(route.modelId).toBe('gel-comb');
    expect(route.parameters).toEqual({});
    expect(route.parameterError).toContain('unsupported');
  });

  it('should reject non-object parameter payloads and prototype-shaped properties', () => {
    expect(() => decodeParameters('1.raw.WzEsMl0')).toThrow(TypeError);
    expect(() => decodeParameters('1.raw.eyJfX3Byb3RvX18iOnsieCI6MX19')).toThrow('valid model parameters');
    expect(() => encodeParameters({ width: Number.NaN })).toThrow(TypeError);
  });

  it('should clear old parameter and variant selections when a model is reset', () => {
    const url = modelUrl('gel-comb', { base: new URL('https://3dd.ahmadjalil.com/gel-comb?variant=replicad&p=old') });
    expect(url.search).toBe('');
    expect(readGalleryLocation(new URL('https://3dd.ahmadjalil.com/tau/')).isGallery).toBe(true);
  });

  it('should distinguish explicitly cleared overrides from a model opened without settings', () => {
    const explicit = modelUrl('gel-comb', { parameters: {} });
    expect(readGalleryLocation(explicit)).toMatchObject({ hasParameters: true, parameters: {} });
    expect(readGalleryLocation(new URL('https://3dd.ahmadjalil.com/gel-comb'))).toMatchObject({
      hasParameters: false,
      parameters: {},
    });
  });
});
