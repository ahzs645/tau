import { describe, expect, it, vi } from 'vitest';
import { useDeferredValue } from 'react';

vi.mock('react', async (importOriginal) => {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.mock importOriginal requires inline typeof import()
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useDeferredValue: vi.fn(actual.useDeferredValue),
  };
});

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({
    camera: {},
    scene: { userData: {}, environmentRotation: { set: vi.fn() } },
  }),
  useFrame: vi.fn(),
}));

vi.mock('@react-three/drei', () => ({
  Environment: ({ children }: { readonly children: React.ReactNode }) => <group>{children}</group>,
  Lightformer: () => <mesh />,
}));

vi.mock('#components/geometry/graphics/three/utils/lights.utils.js', () => ({
  applyLightingForCamera: vi.fn(),
  ambientBaseIntensity: 0.5,
  headlampBaseIntensity: 0.3,
  environmentBaseIntensity: 1,
  defaultHeadlampConfig: {},
  lightingUserDataKeys: { config: 'lightConfig', ambient: 'ambient', headlamp: 'headlamp' },
}));

describe('Lights', () => {
  it('should defer Environment rendering via useDeferredValue', async () => {
    const { Lights } = await import('#components/geometry/graphics/three/react/lights.js');
    const { renderHook } = await import('@testing-library/react');

    // oxlint-disable-next-line new-cap -- invoking component as function for hook testing
    renderHook(() => Lights({ environmentPreset: 'studio' }));

    expect(useDeferredValue).toHaveBeenCalled();
  });
});
