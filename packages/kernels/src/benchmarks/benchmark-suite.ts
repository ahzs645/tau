/**
 * Benchmark Suite
 *
 * Curated set of geometry operations for benchmarking kernel performance.
 * Each case is a self-contained replicad code string that produces geometry.
 * Cases are grouped by category for filtering and reporting.
 */

/** A single benchmark case with its code and metadata. */
export type BenchmarkCase = {
  name: string;
  category: string;
  code: string;
};

const primitives: BenchmarkCase[] = [
  {
    name: 'box',
    category: 'primitives',
    code: `
      import { makeBaseBox } from 'replicad';
      export default function main() {
        return makeBaseBox(50, 30, 20);
      }
    `,
  },
  {
    name: 'cylinder',
    category: 'primitives',
    code: `
      import { makeCylinder } from 'replicad';
      export default function main() {
        return makeCylinder(15, 40);
      }
    `,
  },
  {
    name: 'sphere',
    category: 'primitives',
    code: `
      import { makeSphere } from 'replicad';
      export default function main() {
        return makeSphere(25);
      }
    `,
  },
];

const booleans: BenchmarkCase[] = [
  {
    name: 'fuse-two-boxes',
    category: 'booleans',
    code: `
      import { makeBaseBox } from 'replicad';
      export default function main() {
        const a = makeBaseBox(30, 30, 30);
        const b = makeBaseBox(20, 20, 40).translate(10, 10, 0);
        return a.fuse(b);
      }
    `,
  },
  {
    name: 'cut-cylinder-from-box',
    category: 'booleans',
    code: `
      import { makeBaseBox, makeCylinder } from 'replicad';
      export default function main() {
        const box = makeBaseBox(40, 40, 30);
        const hole = makeCylinder(10, 30);
        return box.cut(hole);
      }
    `,
  },
  {
    name: 'n-body-fuse',
    category: 'booleans',
    code: `
      import { makeBaseBox } from 'replicad';
      export default function main() {
        let result = makeBaseBox(10, 10, 10);
        for (let i = 1; i < 6; i++) {
          result = result.fuse(makeBaseBox(10, 10, 10).translate(i * 8, 0, 0));
        }
        return result;
      }
    `,
  },
];

const fillets: BenchmarkCase[] = [
  {
    name: 'box-fillet-all',
    category: 'fillets',
    code: `
      import { makeBaseBox } from 'replicad';
      export default function main() {
        return makeBaseBox(40, 30, 20).fillet(3);
      }
    `,
  },
  {
    name: 'box-chamfer-all',
    category: 'fillets',
    code: `
      import { makeBaseBox } from 'replicad';
      export default function main() {
        return makeBaseBox(40, 30, 20).chamfer(2);
      }
    `,
  },
];

const extrusions: BenchmarkCase[] = [
  {
    name: 'sketch-extrude',
    category: 'extrusions',
    code: `
      import { draw } from 'replicad';
      export default function main() {
        return draw()
          .movePointerTo([0, 0])
          .lineTo([40, 0])
          .lineTo([40, 30])
          .lineTo([20, 30])
          .lineTo([20, 15])
          .lineTo([0, 15])
          .close()
          .sketchOnPlane("XY")
          .extrude(10);
      }
    `,
  },
  {
    name: 'sketch-revolve',
    category: 'extrusions',
    code: `
      import { draw } from 'replicad';
      export default function main() {
        return draw()
          .movePointerTo([10, 0])
          .lineTo([20, 0])
          .lineTo([20, 30])
          .lineTo([10, 30])
          .close()
          .sketchOnPlane("XZ")
          .revolve();
      }
    `,
  },
];

const complex: BenchmarkCase[] = [
  {
    name: 'bracket',
    category: 'complex',
    code: `
      import { makeBaseBox, makeCylinder } from 'replicad';
      export default function main() {
        let bracket = makeBaseBox(60, 40, 5);
        bracket = bracket.fuse(makeBaseBox(5, 40, 30).translate(-27.5, 0, 15));
        bracket = bracket.fuse(makeBaseBox(5, 40, 30).translate(27.5, 0, 15));
        bracket = bracket.cut(makeCylinder(8, 5).translate(-20, 0, 0));
        bracket = bracket.cut(makeCylinder(8, 5).translate(20, 0, 0));
        bracket = bracket.fillet(2);
        return bracket;
      }
    `,
  },
  {
    name: 'enclosure',
    category: 'complex',
    code: `
      import { makeBaseBox } from 'replicad';
      export default function main() {
        const outer = makeBaseBox(80, 60, 40);
        const inner = makeBaseBox(76, 56, 37).translate(0, 0, 3);
        let enclosure = outer.cut(inner);
        enclosure = enclosure.fillet(3);
        return enclosure;
      }
    `,
  },
  {
    name: 'multi-hole-plate',
    category: 'complex',
    code: `
      import { makeBaseBox, makeCylinder } from 'replicad';
      export default function main() {
        let plate = makeBaseBox(100, 60, 8);
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 5; col++) {
            const x = -40 + col * 20;
            const y = -20 + row * 20;
            plate = plate.cut(makeCylinder(5, 8).translate(x, y, 0));
          }
        }
        plate = plate.fillet(2);
        return plate;
      }
    `,
  },
];

const stress: BenchmarkCase[] = [
  {
    name: 'deep-boolean-chain',
    category: 'stress',
    code: `
      import { makeBaseBox } from 'replicad';
      export default function main() {
        let result = makeBaseBox(10, 10, 10);
        for (let i = 1; i < 12; i++) {
          const dx = (i % 3) * 7;
          const dy = Math.floor(i / 3) * 7;
          result = result.fuse(makeBaseBox(10, 10, 10).translate(dx, dy, 0));
        }
        return result;
      }
    `,
  },
];

export const benchmarkSuite: BenchmarkCase[] = [
  ...primitives,
  ...booleans,
  ...fillets,
  ...extrusions,
  ...complex,
  ...stress,
];

/** All available category names. */
export const benchmarkCategories: string[] = [...new Set(benchmarkSuite.map((c) => c.category))];

/**
 * Filter benchmark cases by category names.
 * Returns all cases if no filter provided.
 */
export function filterBenchmarks(filter?: string[]): BenchmarkCase[] {
  if (!filter || filter.length === 0) {
    return benchmarkSuite;
  }

  return benchmarkSuite.filter((c) => filter.includes(c.category));
}
