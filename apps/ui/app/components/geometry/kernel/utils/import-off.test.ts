import { describe, it, expect } from 'vitest';
import { parseOff } from '#components/geometry/kernel/utils/import-off.js';

describe('parseOff', () => {
  describe('color parsing', () => {
    it('should parse RGB colors from OFF format (values 0-255)', () => {
      // Using "OFF 4 1 0" format (header and counts on same line) as OpenSCAD outputs
      const offContent = `OFF 4 1 0
0 0 0
1 0 0
1 1 0
0 1 0
4 0 1 2 3 255 128 64
`;
      const result = parseOff(offContent);

      expect(result.colors).toHaveLength(2); // Quad is triangulated into 2 triangles
      // RGB values normalized from 0-255 to 0-1, with default alpha of 1
      expect(result.colors[0]).toEqual([1, 128 / 255, 64 / 255, 1]);
      expect(result.colors[1]).toEqual([1, 128 / 255, 64 / 255, 1]);
    });

    it('should parse RGBA colors with opacity from OFF format', () => {
      const offContent = `OFF 4 1 0
0 0 0
1 0 0
1 1 0
0 1 0
4 0 1 2 3 153 204 242 127
`;
      const result = parseOff(offContent);

      expect(result.colors).toHaveLength(2); // Quad is triangulated into 2 triangles
      // RGBA values normalized from 0-255 to 0-1
      // glass_color in OpenSCAD: [0.6, 0.8, 0.95, 0.5] would be [153, 204, 242, 127] in 0-255 range
      expect(result.colors[0]).toEqual([153 / 255, 204 / 255, 242 / 255, 127 / 255]);
      expect(result.colors[1]).toEqual([153 / 255, 204 / 255, 242 / 255, 127 / 255]);
    });

    it('should preserve full opacity (alpha = 1) for RGBA colors', () => {
      const offContent = `OFF 3 1 0
0 0 0
1 0 0
0.5 1 0
3 0 1 2 255 0 0 255
`;
      const result = parseOff(offContent);

      expect(result.colors).toHaveLength(1);
      // Fully opaque red: RGBA(255, 0, 0, 255) -> [1, 0, 0, 1]
      expect(result.colors[0]).toEqual([1, 0, 0, 1]);
    });

    it('should handle semi-transparent colors correctly', () => {
      const offContent = `OFF 3 1 0
0 0 0
1 0 0
0.5 1 0
3 0 1 2 0 0 255 128
`;
      const result = parseOff(offContent);

      expect(result.colors).toHaveLength(1);
      // Semi-transparent blue: RGBA(0, 0, 255, 128) -> [0, 0, 1, ~0.5]
      expect(result.colors[0]?.[0]).toBeCloseTo(0, 5);
      expect(result.colors[0]?.[1]).toBeCloseTo(0, 5);
      expect(result.colors[0]?.[2]).toBeCloseTo(1, 5);
      expect(result.colors[0]?.[3]).toBeCloseTo(128 / 255, 5);
    });

    it('should default to opaque white for faces without color data', () => {
      const offContent = `OFF 3 1 0
0 0 0
1 0 0
0.5 1 0
3 0 1 2
`;
      const result = parseOff(offContent);

      expect(result.colors).toHaveLength(1);
      // Default color: opaque white [1, 1, 1, 1]
      expect(result.colors[0]).toEqual([1, 1, 1, 1]);
    });

    it('should handle multiple faces with different transparencies', () => {
      const offContent = `OFF 6 2 0
0 0 0
1 0 0
0.5 1 0
2 0 0
3 0 0
2.5 1 0
3 0 1 2 255 0 0 255
3 3 4 5 0 0 255 127
`;
      const result = parseOff(offContent);

      expect(result.colors).toHaveLength(2);
      // First face: opaque red
      expect(result.colors[0]).toEqual([1, 0, 0, 1]);
      // Second face: semi-transparent blue
      expect(result.colors[1]?.[0]).toBeCloseTo(0, 5);
      expect(result.colors[1]?.[1]).toBeCloseTo(0, 5);
      expect(result.colors[1]?.[2]).toBeCloseTo(1, 5);
      expect(result.colors[1]?.[3]).toBeCloseTo(127 / 255, 5);
    });
  });
});
