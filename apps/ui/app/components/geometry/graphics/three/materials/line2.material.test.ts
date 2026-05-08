// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Line2NodeMaterial as ThreeLine2NodeMaterial, NodeMaterial as ThreeNodeMaterial } from 'three/webgpu';
import { Line2NodeMaterial } from '#components/geometry/graphics/three/materials/line2.material.js';
import { serialiseStrippedTslGraph } from '#components/geometry/graphics/three/utils/tsl-node-graph-snapshot.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));

type SetupPrototypeShim = {
  setup: (...callArgs: readonly unknown[]) => unknown;
};

const nodeMaterialPrototype = ThreeNodeMaterial.prototype as unknown as SetupPrototypeShim;
const line2Prototype = ThreeLine2NodeMaterial.prototype as unknown as SetupPrototypeShim;

describe('Line2NodeMaterial TSL snapshots', () => {
  it('materialises a node graph distinct from stock ThreeLine2NodeMaterial (trimSegmentCameraNear layout)', () => {
    const material = new Line2NodeMaterial({
      color: 0xff_00_ff,
      linewidth: 1,
      opacity: 0.6,
      transparent: true,
      worldUnits: false,
    });
    expect(material.type).toBe('Line2NodeMaterial');
  });

  it('matches stable stripped WebGPU line2 node material JSON snapshot', async () => {
    const material = new Line2NodeMaterial({
      color: 0xff_00_ff,
      linewidth: 1,
      opacity: 0.6,
      transparent: true,
      worldUnits: false,
    });
    const serialised = serialiseStrippedTslGraph(material.toJSON());

    await expect(serialised).toMatchFileSnapshot(
      join(currentDirectory, '__shader-snapshots__', 'line2-node-material.json'),
    );
  });
});

describe('Line2NodeMaterial.setup parent dispatch (regression guard)', () => {
  /**
   * Smoking-gun regression: if `setup()` ever ends with `super.setup(builder)`, that resolves to
   * **`ThreeLine2NodeMaterial.setup`**, which rebuilds `vertexNode`/`colorNode`/`outputNode` with the
   * upstream **`nearEstimate = b * -0.5 / a`** trim — silently overwriting the corrected graph
   * (under reversed-Z that collapses to `-far/2` and flips long axes into the opposite hemisphere
   * via `mix(start, end, alpha)`). The static **`material.toJSON()`** snapshot can't catch this
   * because TSL graphs are built lazily inside `setup`. Patching the two prototype `setup` methods
   * by hand and counting calls is the cheapest way to assert which parent runs.
   */
  it('skips ThreeLine2NodeMaterial.setup and dispatches to NodeMaterial.setup directly', () => {
    const material = new Line2NodeMaterial({
      color: 0xff_00_ff,
      linewidth: 1,
      opacity: 0.6,
      transparent: true,
      worldUnits: false,
    });

    const originalNodeMaterialSetup = nodeMaterialPrototype.setup;
    const originalLine2Setup = line2Prototype.setup;

    let nodeMaterialSetupCalls = 0;
    let line2SetupCalls = 0;

    nodeMaterialPrototype.setup = () => {
      nodeMaterialSetupCalls += 1;
    };
    // Forward to the patched grandparent so the dispatch chain stays observable
    // even if the override regresses to `super.setup(builder)`.
    line2Prototype.setup = function patchedLine2Setup(this: unknown, ...callArgs: readonly unknown[]): unknown {
      line2SetupCalls += 1;
      return Reflect.apply(nodeMaterialPrototype.setup, this, callArgs);
    };

    let setupError: unknown;
    try {
      const stubBuilder = { renderer: { currentSamples: 0 } };
      material.setup(stubBuilder);
    } catch (error) {
      setupError = error;
    } finally {
      nodeMaterialPrototype.setup = originalNodeMaterialSetup;
      line2Prototype.setup = originalLine2Setup;
    }

    expect(setupError).toBeUndefined();
    expect(line2SetupCalls).toBe(0);
    expect(nodeMaterialSetupCalls).toBe(1);

    type NodeBearingMaterial = {
      readonly vertexNode?: unknown;
      readonly colorNode?: unknown;
    };
    const nodeView = material as unknown as NodeBearingMaterial;
    expect(nodeView.vertexNode).toBeDefined();
    expect(nodeView.colorNode).toBeDefined();
  });
});
