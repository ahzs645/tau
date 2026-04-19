import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import {
  sceneTag,
  hasSceneTag,
  setSceneTag,
  clearSceneTag,
  findBySceneTag,
  sceneTagData,
} from '#components/geometry/graphics/three/utils/scene-tags.js';
import type { SceneTagKey } from '#components/geometry/graphics/three/utils/scene-tags.js';

describe('scene-tags', () => {
  // ===================================================================
  // sceneTag registry
  // ===================================================================

  describe('sceneTag', () => {
    it('should expose all expected tag keys with stable string values', () => {
      expect(sceneTag.sectionViewHelper).toBe('isSectionViewHelper');
      expect(sceneTag.previewOnly).toBe('isPreviewOnly');
      expect(sceneTag.measurementUi).toBe('isMeasurementUi');
      expect(Object.keys(sceneTag)).toHaveLength(3);
    });
  });

  // ===================================================================
  // hasSceneTag
  // ===================================================================

  describe('hasSceneTag', () => {
    it('should return true when the tag is set on userData', () => {
      const object = new THREE.Object3D();
      object.userData[sceneTag.previewOnly] = true;

      expect(hasSceneTag(object, sceneTag.previewOnly)).toBe(true);
    });

    it('should return false when the tag is not set', () => {
      const object = new THREE.Object3D();

      expect(hasSceneTag(object, sceneTag.sectionViewHelper)).toBe(false);
    });

    it('should return false when userData is empty', () => {
      const object = new THREE.Object3D();

      for (const tag of Object.values(sceneTag)) {
        expect(hasSceneTag(object, tag as SceneTagKey)).toBe(false);
      }
    });

    it('should return false for falsy values (0, empty string, null)', () => {
      const object = new THREE.Object3D();
      object.userData[sceneTag.previewOnly] = 0;
      expect(hasSceneTag(object, sceneTag.previewOnly)).toBe(false);

      object.userData[sceneTag.previewOnly] = '';
      expect(hasSceneTag(object, sceneTag.previewOnly)).toBe(false);

      object.userData[sceneTag.previewOnly] = null;
      expect(hasSceneTag(object, sceneTag.previewOnly)).toBe(false);
    });
  });

  // ===================================================================
  // setSceneTag
  // ===================================================================

  describe('setSceneTag', () => {
    it('should set the tag to true by default', () => {
      const object = new THREE.Object3D();
      setSceneTag(object, sceneTag.measurementUi);

      expect(object.userData[sceneTag.measurementUi]).toBe(true);
    });

    it('should set the tag to a custom boolean value when provided', () => {
      const object = new THREE.Object3D();
      setSceneTag(object, sceneTag.previewOnly, false);

      expect(object.userData[sceneTag.previewOnly]).toBe(false);
    });

    it('should be readable by hasSceneTag after being set', () => {
      const object = new THREE.Object3D();
      setSceneTag(object, sceneTag.sectionViewHelper);

      expect(hasSceneTag(object, sceneTag.sectionViewHelper)).toBe(true);
    });
  });

  // ===================================================================
  // clearSceneTag
  // ===================================================================

  describe('clearSceneTag', () => {
    it('should remove a previously set tag', () => {
      const object = new THREE.Object3D();
      setSceneTag(object, sceneTag.previewOnly);
      clearSceneTag(object, sceneTag.previewOnly);

      expect(sceneTag.previewOnly in object.userData).toBe(false);
    });

    it('should cause hasSceneTag to return false after clearing', () => {
      const object = new THREE.Object3D();
      setSceneTag(object, sceneTag.sectionViewHelper);
      expect(hasSceneTag(object, sceneTag.sectionViewHelper)).toBe(true);

      clearSceneTag(object, sceneTag.sectionViewHelper);
      expect(hasSceneTag(object, sceneTag.sectionViewHelper)).toBe(false);
    });

    it('should not throw when clearing an unset tag', () => {
      const object = new THREE.Object3D();
      expect(() => {
        clearSceneTag(object, sceneTag.measurementUi);
      }).not.toThrow();
    });
  });

  // ===================================================================
  // findBySceneTag
  // ===================================================================

  describe('findBySceneTag', () => {
    it('should return all descendants with the given tag', () => {
      const root = new THREE.Group();
      const tagged1 = new THREE.Mesh();
      const tagged2 = new THREE.Mesh();
      const untagged = new THREE.Mesh();

      setSceneTag(tagged1, sceneTag.previewOnly);
      setSceneTag(tagged2, sceneTag.previewOnly);
      root.add(tagged1, tagged2, untagged);

      const results = findBySceneTag(root, sceneTag.previewOnly);
      expect(results).toHaveLength(2);
      expect(results).toContain(tagged1);
      expect(results).toContain(tagged2);
    });

    it('should return empty array when no objects have the tag', () => {
      const root = new THREE.Group();
      root.add(new THREE.Mesh(), new THREE.Mesh());

      expect(findBySceneTag(root, sceneTag.sectionViewHelper)).toEqual([]);
    });

    it('should include deeply nested tagged objects', () => {
      const root = new THREE.Group();
      const child = new THREE.Group();
      const grandchild = new THREE.Group();
      const deepMesh = new THREE.Mesh();

      setSceneTag(deepMesh, sceneTag.measurementUi);
      grandchild.add(deepMesh);
      child.add(grandchild);
      root.add(child);

      const results = findBySceneTag(root, sceneTag.measurementUi);
      expect(results).toEqual([deepMesh]);
    });

    it('should not include the root if root is not tagged', () => {
      const root = new THREE.Group();
      const child = new THREE.Mesh();
      setSceneTag(child, sceneTag.previewOnly);
      root.add(child);

      const results = findBySceneTag(root, sceneTag.previewOnly);
      expect(results).toEqual([child]);
    });

    it('should include the root if root is tagged', () => {
      const root = new THREE.Group();
      setSceneTag(root, sceneTag.sectionViewHelper);
      root.add(new THREE.Mesh());

      const results = findBySceneTag(root, sceneTag.sectionViewHelper);
      expect(results).toContain(root);
    });
  });

  // ===================================================================
  // sceneTagData
  // ===================================================================

  describe('sceneTagData', () => {
    it('should return a userData object with the tag set to true', () => {
      expect(sceneTagData(sceneTag.sectionViewHelper)).toEqual({
        isSectionViewHelper: true,
      });
    });

    it('should produce an object compatible with hasSceneTag', () => {
      const object = new THREE.Object3D();
      Object.assign(object.userData, sceneTagData(sceneTag.measurementUi));

      expect(hasSceneTag(object, sceneTag.measurementUi)).toBe(true);
    });
  });

  // ===================================================================
  // Integration: producer-consumer contracts
  // ===================================================================

  describe('integration', () => {
    describe('matcap material replacement', () => {
      /**
       * Replicates the traversal contract from applyMatcapToClonedScene:
       * tagged SectionViewHelper objects are skipped, untagged meshes get replaced.
       */
      const applyMatcapTraversal = (scene: THREE.Scene): THREE.Mesh[] => {
        const replaced: THREE.Mesh[] = [];
        scene.traverse((child) => {
          if (hasSceneTag(child, sceneTag.sectionViewHelper)) {
            return;
          }
          if ('isMesh' in child && child.isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.material = new THREE.MeshMatcapMaterial();
            replaced.push(mesh);
          }
        });
        return replaced;
      };

      it('should skip material replacement for objects tagged sectionViewHelper', () => {
        const scene = new THREE.Scene();
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const originalMaterial = new THREE.MeshBasicMaterial({ color: 0xff_00_00 });

        const taggedMesh = new THREE.Mesh(geometry, originalMaterial);
        setSceneTag(taggedMesh, sceneTag.sectionViewHelper);
        scene.add(taggedMesh);

        const replaced = applyMatcapTraversal(scene);

        expect(replaced).toHaveLength(0);
        expect(taggedMesh.material).toBe(originalMaterial);
      });

      it('should replace materials for untagged mesh objects', () => {
        const scene = new THREE.Scene();
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const originalMaterial = new THREE.MeshBasicMaterial({ color: 0x00_ff_00 });
        const untaggedMesh = new THREE.Mesh(geometry, originalMaterial);
        scene.add(untaggedMesh);

        const replaced = applyMatcapTraversal(scene);

        expect(replaced).toHaveLength(1);
        expect(untaggedMesh.material).toBeInstanceOf(THREE.MeshMatcapMaterial);
      });
    });

    describe('screenshot scene preparation', () => {
      it('should hide previewOnly objects when isPreview is true', () => {
        const scene = new THREE.Scene();
        const previewMesh = new THREE.Mesh();
        const normalMesh = new THREE.Mesh();

        setSceneTag(previewMesh, sceneTag.previewOnly);
        scene.add(previewMesh, normalMesh);

        const clonedScene = scene.clone();

        // Replicate the screenshot machine's preview-only hiding logic
        clonedScene.traverse((object) => {
          if (hasSceneTag(object, sceneTag.previewOnly)) {
            object.visible = false;
          }
        });

        const previewObjects = findBySceneTag(clonedScene, sceneTag.previewOnly);
        expect(previewObjects).toHaveLength(1);
        expect(previewObjects[0]!.visible).toBe(false);

        // Untagged objects remain visible
        const allChildren = clonedScene.children;
        const visibleUntagged = allChildren.filter((child) => !hasSceneTag(child, sceneTag.previewOnly));
        expect(visibleUntagged).toHaveLength(1);
        expect(visibleUntagged[0]!.visible).toBe(true);
      });

      it('should hide sectionViewHelper objects for bbox computation then restore', () => {
        const scene = new THREE.Scene();

        const modelMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
        const helper1 = new THREE.Mesh(new THREE.PlaneGeometry(10_000, 10_000), new THREE.MeshBasicMaterial());
        const helper2 = new THREE.Mesh(new THREE.PlaneGeometry(10_000, 10_000), new THREE.MeshBasicMaterial());
        setSceneTag(helper1, sceneTag.sectionViewHelper);
        setSceneTag(helper2, sceneTag.sectionViewHelper);

        scene.add(modelMesh, helper1, helper2);

        // All visible initially
        expect(helper1.visible).toBe(true);
        expect(helper2.visible).toBe(true);

        // Replicate the screenshot machine's hide-for-bbox logic
        const helpers = findBySceneTag(scene, sceneTag.sectionViewHelper);
        expect(helpers).toHaveLength(2);

        for (const helper of helpers) {
          helper.visible = false;
        }

        expect(helper1.visible).toBe(false);
        expect(helper2.visible).toBe(false);
        expect(modelMesh.visible).toBe(true);

        // Restore visibility
        for (const helper of helpers) {
          helper.visible = true;
        }

        expect(helper1.visible).toBe(true);
        expect(helper2.visible).toBe(true);
      });
    });

    describe('raycast mesh filtering', () => {
      it('should exclude measurementUi tagged meshes from the mesh list', () => {
        const scene = new THREE.Scene();
        const measureMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
        setSceneTag(measureMesh, sceneTag.measurementUi);

        const modelMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());

        scene.add(measureMesh, modelMesh);

        // Replicate the measure-tool's filtering logic
        const meshes: THREE.Object3D[] = [];
        scene.traverse((object) => {
          if (object instanceof THREE.Mesh && object.visible && !hasSceneTag(object, sceneTag.measurementUi)) {
            meshes.push(object as THREE.Object3D);
          }
        });

        expect(meshes).toHaveLength(1);
        expect(meshes).toContain(modelMesh);
        expect(meshes).not.toContain(measureMesh);
      });

      it('should include untagged visible meshes', () => {
        const scene = new THREE.Scene();
        const mesh1 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
        const mesh2 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
        scene.add(mesh1, mesh2);

        const meshes: THREE.Object3D[] = [];
        scene.traverse((object) => {
          if (object instanceof THREE.Mesh && object.visible && !hasSceneTag(object, sceneTag.measurementUi)) {
            meshes.push(object as THREE.Object3D);
          }
        });

        expect(meshes).toHaveLength(2);
        expect(meshes).toContain(mesh1);
        expect(meshes).toContain(mesh2);
      });
    });
  });
});
