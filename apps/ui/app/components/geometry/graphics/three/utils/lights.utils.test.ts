import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  computeEnvironmentRotation,
  computeHeadlampTransform,
  applyLightingForCamera,
  findTaggedLights,
  defaultHeadlampConfig,
  ambientBaseIntensity,
  headlampBaseIntensity,
  environmentBaseIntensity,
  lightingUserDataKeys,
} from '#components/geometry/graphics/three/utils/lights.utils.js';
import type { HeadlampConfig, LightingConfig } from '#components/geometry/graphics/three/utils/lights.utils.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a PerspectiveCamera positioned along +Z looking at origin. */
function createTestCamera(fov = 54, distance = 10): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 1000);
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/** Creates a minimal Scene with environment rotation support. */
function createTestScene(): THREE.Scene {
  const scene = new THREE.Scene();
  return scene;
}

/** Creates the default lighting config used in most tests. */
function createDefaultLightingConfig(overrides?: Partial<LightingConfig>): LightingConfig {
  return {
    sceneRadius: 5,
    upDirection: 'z',
    headlampIntensity: headlampBaseIntensity,
    ambientIntensity: ambientBaseIntensity,
    environmentIntensity: environmentBaseIntensity,
    headlampConfig: defaultHeadlampConfig,
    ...overrides,
  };
}

// ── computeEnvironmentRotation ──────────────────────────────────────────────

describe('computeEnvironmentRotation', () => {
  describe('identity camera', () => {
    it('should produce a near-zero Euler for an identity quaternion', () => {
      const identityQuat = new THREE.Quaternion(); // (0, 0, 0, 1)
      const euler = computeEnvironmentRotation(identityQuat, 'z');

      expect(euler.x).toBeCloseTo(0, 6);
      expect(euler.y).toBeCloseTo(0, 6);
      expect(euler.z).toBeCloseTo(0, 6);
    });
  });

  describe('euler order selection', () => {
    it('should use ZXY order for z-up', () => {
      const quat = new THREE.Quaternion();
      const euler = computeEnvironmentRotation(quat, 'z');
      expect(euler.order).toBe('ZXY');
    });

    it('should use YXZ order for y-up', () => {
      const quat = new THREE.Quaternion();
      const euler = computeEnvironmentRotation(quat, 'y');
      expect(euler.order).toBe('YXZ');
    });

    it('should use XZY order for x-up', () => {
      const quat = new THREE.Quaternion();
      const euler = computeEnvironmentRotation(quat, 'x');
      expect(euler.order).toBe('XZY');
    });
  });

  describe('90-degree yaw rotation', () => {
    it('should produce a non-trivial Euler for a 90° rotation around Z', () => {
      const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      const euler = computeEnvironmentRotation(quat, 'z');

      // The result should not be all zeros (camera is rotated)
      const magnitude = Math.abs(euler.x) + Math.abs(euler.y) + Math.abs(euler.z);
      expect(magnitude).toBeGreaterThan(0.01);
    });
  });

  describe('pre-negation', () => {
    it('should negate all Euler components relative to the raw extraction', () => {
      const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 4);
      const result = computeEnvironmentRotation(quat, 'z');

      // Manually compute what the raw (un-negated) extraction would be
      const inverted = quat.clone().invert();
      const rawEuler = new THREE.Euler().setFromQuaternion(inverted, 'ZXY');

      expect(result.x).toBeCloseTo(-rawEuler.x, 6);
      expect(result.y).toBeCloseTo(-rawEuler.y, 6);
      expect(result.z).toBeCloseTo(-rawEuler.z, 6);
    });
  });

  describe('does not mutate input', () => {
    it('should not modify the input quaternion', () => {
      const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
      const originalW = quat.w;
      const originalX = quat.x;
      const originalY = quat.y;
      const originalZ = quat.z;

      computeEnvironmentRotation(quat, 'z');

      expect(quat.x).toBe(originalX);
      expect(quat.y).toBe(originalY);
      expect(quat.z).toBe(originalZ);
      expect(quat.w).toBe(originalW);
    });
  });
});

// ── computeHeadlampTransform ────────────────────────────────────────────────

describe('computeHeadlampTransform', () => {
  describe('identity camera matrix', () => {
    it('should offset position in camera-up (+Y) and camera-right (+X) directions', () => {
      const cameraPosition = new THREE.Vector3(0, 0, 10);
      const cameraMatrix = new THREE.Matrix4().identity();
      const radius = 5;

      const { position } = computeHeadlampTransform(cameraPosition, cameraMatrix, radius, defaultHeadlampConfig);

      // With identity matrix:
      // camera-right = column 0 = (1,0,0)
      // camera-up = column 1 = (0,1,0)
      // Expected position: (0,0,10) + (0,1,0) * 5 * 2.1 + (1,0,0) * 5 * -0.1
      const expectedX = 0 + radius * defaultHeadlampConfig.rightOffset;
      const expectedY = 0 + radius * defaultHeadlampConfig.upOffset;
      const expectedZ = 10;

      expect(position.x).toBeCloseTo(expectedX, 6);
      expect(position.y).toBeCloseTo(expectedY, 6);
      expect(position.z).toBeCloseTo(expectedZ, 6);
    });

    it('should place the target forward of camera with skew offsets', () => {
      const cameraPosition = new THREE.Vector3(0, 0, 10);
      const cameraMatrix = new THREE.Matrix4().identity();
      const radius = 5;

      const { targetPosition } = computeHeadlampTransform(cameraPosition, cameraMatrix, radius, defaultHeadlampConfig);

      // With identity matrix:
      // camera-forward = -column2 = (0,0,-1) negated = (0,0,1)... actually
      // column 2 of identity = (0,0,1), negated = (0,0,-1)
      // forward direction = -column2 = (0,0,-1)
      // target = camera_pos + forward * radius * 2 + right * (-radius * skew) + up * (-radius * skew)
      const expectedZ = 10 + -1 * radius * 2;
      const expectedX = 0 + -radius * defaultHeadlampConfig.targetRightSkew;
      const expectedY = 0 + -radius * defaultHeadlampConfig.targetUpSkew;

      expect(targetPosition.x).toBeCloseTo(expectedX, 6);
      expect(targetPosition.y).toBeCloseTo(expectedY, 6);
      expect(targetPosition.z).toBeCloseTo(expectedZ, 6);
    });
  });

  describe('scaling with sceneRadius', () => {
    it('should produce proportionally larger offsets with larger radius', () => {
      const cameraPosition = new THREE.Vector3(0, 0, 10);
      const cameraMatrix = new THREE.Matrix4().identity();

      const small = computeHeadlampTransform(cameraPosition, cameraMatrix, 1, defaultHeadlampConfig);
      const large = computeHeadlampTransform(cameraPosition, cameraMatrix, 10, defaultHeadlampConfig);

      // The offset from camera position should be 10x larger
      const smallOffset = small.position.clone().sub(cameraPosition);
      const largeOffset = large.position.clone().sub(cameraPosition);

      expect(largeOffset.length()).toBeCloseTo(smallOffset.length() * 10, 4);
    });
  });

  describe('custom config', () => {
    it('should respect custom offset values', () => {
      const cameraPosition = new THREE.Vector3(0, 0, 0);
      const cameraMatrix = new THREE.Matrix4().identity();
      const radius = 1;
      const config: HeadlampConfig = {
        rightOffset: 1,
        upOffset: 1,
        targetRightSkew: 0,
        targetUpSkew: 0,
      };

      const { position } = computeHeadlampTransform(cameraPosition, cameraMatrix, radius, config);

      // Camera-right = (1,0,0), camera-up = (0,1,0)
      // position = (0,0,0) + (0,1,0)*1*1 + (1,0,0)*1*1 = (1, 1, 0)
      expect(position.x).toBeCloseTo(1, 6);
      expect(position.y).toBeCloseTo(1, 6);
      expect(position.z).toBeCloseTo(0, 6);
    });
  });

  describe('does not mutate input', () => {
    it('should not modify the input camera position', () => {
      const cameraPosition = new THREE.Vector3(1, 2, 3);
      const originalX = cameraPosition.x;
      const originalY = cameraPosition.y;
      const originalZ = cameraPosition.z;
      const cameraMatrix = new THREE.Matrix4().identity();

      computeHeadlampTransform(cameraPosition, cameraMatrix, 5, defaultHeadlampConfig);

      expect(cameraPosition.x).toBe(originalX);
      expect(cameraPosition.y).toBe(originalY);
      expect(cameraPosition.z).toBe(originalZ);
    });
  });
});

// ── applyLightingForCamera ──────────────────────────────────────────────────

describe('applyLightingForCamera', () => {
  describe('environment rotation', () => {
    it('should set scene.environmentRotation based on camera orientation', () => {
      const scene = createTestScene();
      const camera = createTestCamera();
      const config = createDefaultLightingConfig();

      applyLightingForCamera({ scene, camera, headlamp: undefined, ambient: undefined, config });

      // EnvironmentRotation should have been set (not identity if camera is looking at origin from +Z)
      const euler = scene.environmentRotation;
      expect(euler).toBeDefined();
      // The Euler order should match z-up
      expect(euler.order).toBe('ZXY');
    });
  });

  describe('environment intensity', () => {
    it('should set scene.environmentIntensity using FOV compensation', () => {
      const scene = createTestScene();
      const camera = createTestCamera(54); // Reference FOV
      const config = createDefaultLightingConfig();

      applyLightingForCamera({ scene, camera, headlamp: undefined, ambient: undefined, config });

      // At reference FOV (54), envFactor ≈ 1.0, so intensity ≈ base
      expect(scene.environmentIntensity).toBeCloseTo(environmentBaseIntensity, 2);
    });

    it('should reduce environment intensity at low FOV', () => {
      const scene = createTestScene();
      const camera = createTestCamera(10); // Low FOV
      const config = createDefaultLightingConfig();

      applyLightingForCamera({ scene, camera, headlamp: undefined, ambient: undefined, config });

      expect(scene.environmentIntensity).toBeLessThan(environmentBaseIntensity);
    });
  });

  describe('headlamp positioning', () => {
    it('should update headlamp position and intensity when provided', () => {
      const scene = createTestScene();
      const camera = createTestCamera();
      const headlamp = new THREE.DirectionalLight('white', 1);
      scene.add(headlamp);
      scene.add(headlamp.target);
      const config = createDefaultLightingConfig();

      const originalPosition = headlamp.position.clone();

      applyLightingForCamera({ scene, camera, headlamp, ambient: undefined, config });

      // Position should have changed
      expect(headlamp.position.equals(originalPosition)).toBe(false);
      // Intensity should be set (at reference FOV, headlampFactor ≈ 1.0)
      expect(headlamp.intensity).toBeCloseTo(headlampBaseIntensity, 2);
    });

    it('should not throw when headlamp is undefined', () => {
      const scene = createTestScene();
      const camera = createTestCamera();
      const config = createDefaultLightingConfig();

      expect(() => {
        applyLightingForCamera({ scene, camera, headlamp: undefined, ambient: undefined, config });
      }).not.toThrow();
    });
  });

  describe('ambient light', () => {
    it('should update ambient intensity with FOV compensation when provided', () => {
      const scene = createTestScene();
      const camera = createTestCamera(54); // Reference FOV
      const ambient = new THREE.AmbientLight('white', 1);
      scene.add(ambient);
      const config = createDefaultLightingConfig();

      applyLightingForCamera({ scene, camera, headlamp: undefined, ambient, config });

      // At reference FOV, ambientFactor ≈ 1.0
      expect(ambient.intensity).toBeCloseTo(ambientBaseIntensity, 2);
    });

    it('should boost ambient intensity at low FOV', () => {
      const scene = createTestScene();
      const camera = createTestCamera(10); // Low FOV
      const ambient = new THREE.AmbientLight('white', 1);
      scene.add(ambient);
      const config = createDefaultLightingConfig();

      applyLightingForCamera({ scene, camera, headlamp: undefined, ambient, config });

      // At low FOV, ambientFactor > 1.0
      expect(ambient.intensity).toBeGreaterThan(ambientBaseIntensity);
    });

    it('should not throw when ambient is undefined', () => {
      const scene = createTestScene();
      const camera = createTestCamera();
      const config = createDefaultLightingConfig();

      expect(() => {
        applyLightingForCamera({ scene, camera, headlamp: undefined, ambient: undefined, config });
      }).not.toThrow();
    });
  });

  describe('consistency across camera angles', () => {
    it('should produce different environment rotations for different camera orientations', () => {
      const scene1 = createTestScene();
      const scene2 = createTestScene();

      const camera1 = createTestCamera();
      camera1.position.set(0, 0, 10);
      camera1.lookAt(0, 0, 0);
      camera1.updateMatrixWorld(true);

      const camera2 = createTestCamera();
      camera2.position.set(10, 0, 0);
      camera2.lookAt(0, 0, 0);
      camera2.updateMatrixWorld(true);

      const config = createDefaultLightingConfig();

      applyLightingForCamera({ scene: scene1, camera: camera1, headlamp: undefined, ambient: undefined, config });
      applyLightingForCamera({ scene: scene2, camera: camera2, headlamp: undefined, ambient: undefined, config });

      // Different camera positions should produce different rotations
      const rot1 = scene1.environmentRotation;
      const rot2 = scene2.environmentRotation;
      const isIdentical =
        Math.abs(rot1.x - rot2.x) < 1e-6 && Math.abs(rot1.y - rot2.y) < 1e-6 && Math.abs(rot1.z - rot2.z) < 1e-6;
      expect(isIdentical).toBe(false);
    });
  });
});

// ── findTaggedLights ────────────────────────────────────────────────────────

describe('findTaggedLights', () => {
  it('should find tagged headlamp and ambient light in a scene', () => {
    const scene = createTestScene();
    const headlamp = new THREE.DirectionalLight('white', 1);
    headlamp.userData[lightingUserDataKeys.headlamp] = true;
    const ambient = new THREE.AmbientLight('white', 1);
    ambient.userData[lightingUserDataKeys.ambient] = true;
    scene.add(headlamp);
    scene.add(ambient);

    const result = findTaggedLights(scene);

    expect(result.headlamp).toBe(headlamp);
    expect(result.ambient).toBe(ambient);
  });

  it('should return undefined for missing lights', () => {
    const scene = createTestScene();

    const result = findTaggedLights(scene);

    expect(result.headlamp).toBeUndefined();
    expect(result.ambient).toBeUndefined();
  });

  it('should find lights nested in groups', () => {
    const scene = createTestScene();
    const group = new THREE.Group();
    const headlamp = new THREE.DirectionalLight('white', 1);
    headlamp.userData[lightingUserDataKeys.headlamp] = true;
    group.add(headlamp);
    scene.add(group);

    const result = findTaggedLights(scene);

    expect(result.headlamp).toBe(headlamp);
  });

  it('should not return untagged lights', () => {
    const scene = createTestScene();
    const untaggedLight = new THREE.DirectionalLight('white', 1);
    scene.add(untaggedLight);

    const result = findTaggedLights(scene);

    expect(result.headlamp).toBeUndefined();
    expect(result.ambient).toBeUndefined();
  });
});
