import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Geometry, ExportFile } from '@taucad/types';
import { exportFromGlb } from '@taucad/converter';
import { downloadBlob } from '@taucad/utils/file';
import { useGeometryExport } from '#hooks/use-geometry-export.js';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('@taucad/converter', () => ({
  exportFromGlb: vi.fn(),
}));

vi.mock('@taucad/utils/file', () => ({
  asBuffer: (data: ArrayBufferLike) => new Uint8Array(data),
  downloadBlob: vi.fn(),
}));

// ── Test data ──────────────────────────────────────────────────────────

const glbContent = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

const gltfGeometry: Geometry = {
  format: 'gltf',
  content: glbContent,
  hash: 'abc123',
};

const svgGeometry: Geometry = {
  format: 'svg',
  paths: ['M0 0'],
  viewbox: '0 0 100 100',
  name: 'test',
  hash: 'def456',
};

const mockExportFile: ExportFile = {
  name: 'result.stl',
  bytes: new Uint8Array([10, 20, 30]),
  mimeType: 'application/octet-stream',
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('useGeometryExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── canExport ──────────────────────────────────────────────────────

  describe('canExport', () => {
    it('should return true when geometries contain a gltf format entry', () => {
      const { result } = renderHook(() => useGeometryExport({ geometries: [gltfGeometry] }));

      expect(result.current.canExport).toBe(true);
    });

    it('should return false when geometries have no gltf format entry', () => {
      const { result } = renderHook(() => useGeometryExport({ geometries: [svgGeometry] }));

      expect(result.current.canExport).toBe(false);
    });

    it('should return false when geometries array is empty', () => {
      const { result } = renderHook(() => useGeometryExport({ geometries: [] }));

      expect(result.current.canExport).toBe(false);
    });

    it('should return true when geometries contain mixed formats including gltf', () => {
      const { result } = renderHook(() => useGeometryExport({ geometries: [svgGeometry, gltfGeometry] }));

      expect(result.current.canExport).toBe(true);
    });
  });

  // ── isExporting ────────────────────────────────────────────────────

  describe('isExporting', () => {
    it('should initially be false', () => {
      const { result } = renderHook(() => useGeometryExport({ geometries: [gltfGeometry] }));

      expect(result.current.isExporting).toBe(false);
    });
  });

  // ── exportGeometry ─────────────────────────────────────────────────

  describe('exportGeometry', () => {
    it('should call exportFromGlb with the gltf content and format', async () => {
      vi.mocked(exportFromGlb).mockResolvedValue([mockExportFile]);

      const { result } = renderHook(() => useGeometryExport({ geometries: [gltfGeometry] }));

      await act(async () => {
        result.current.exportGeometry('stl');
      });

      expect(exportFromGlb).toHaveBeenCalledWith(glbContent, 'stl');
    });

    it('should download the exported file with default filename', async () => {
      vi.mocked(exportFromGlb).mockResolvedValue([mockExportFile]);

      const { result } = renderHook(() => useGeometryExport({ geometries: [gltfGeometry] }));

      await act(async () => {
        result.current.exportGeometry('stl');
      });

      expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'model.stl');
    });

    it('should use custom defaultFilename when provided', async () => {
      vi.mocked(exportFromGlb).mockResolvedValue([mockExportFile]);

      const { result } = renderHook(() =>
        useGeometryExport({ geometries: [gltfGeometry], defaultFilename: 'my-model' }),
      );

      await act(async () => {
        result.current.exportGeometry('obj');
      });

      expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'my-model.obj');
    });

    it('should use explicit filename over defaultFilename', async () => {
      vi.mocked(exportFromGlb).mockResolvedValue([mockExportFile]);

      const { result } = renderHook(() =>
        useGeometryExport({ geometries: [gltfGeometry], defaultFilename: 'fallback' }),
      );

      await act(async () => {
        result.current.exportGeometry('step', 'override');
      });

      expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'override.step');
    });

    it('should call onError when no gltf geometry is available', async () => {
      const onError = vi.fn();

      const { result } = renderHook(() => useGeometryExport({ geometries: [svgGeometry], onError }));

      await act(async () => {
        result.current.exportGeometry('stl');
      });

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'No GLB geometry available. Model must be rendered first.',
        }),
      );
      expect(exportFromGlb).not.toHaveBeenCalled();
    });

    it('should call onSuccess with filename on successful export', async () => {
      vi.mocked(exportFromGlb).mockResolvedValue([mockExportFile]);
      const onSuccess = vi.fn();

      const { result } = renderHook(() => useGeometryExport({ geometries: [gltfGeometry], onSuccess }));

      await act(async () => {
        result.current.exportGeometry('stl');
      });

      expect(onSuccess).toHaveBeenCalledWith('model.stl');
    });

    it('should call onError when export fails', async () => {
      const exportError = new Error('Conversion failed');
      vi.mocked(exportFromGlb).mockRejectedValue(exportError);
      const onError = vi.fn();

      const { result } = renderHook(() => useGeometryExport({ geometries: [gltfGeometry], onError }));

      await act(async () => {
        result.current.exportGeometry('stl');
      });

      expect(onError).toHaveBeenCalledWith(exportError);
    });

    it('should call onError when export returns empty result', async () => {
      vi.mocked(exportFromGlb).mockResolvedValue([]);
      const onError = vi.fn();

      const { result } = renderHook(() => useGeometryExport({ geometries: [gltfGeometry], onError }));

      await act(async () => {
        result.current.exportGeometry('stl');
      });

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'No file returned from export' }));
    });

    it('should not throw when callbacks are not provided', async () => {
      vi.mocked(exportFromGlb).mockResolvedValue([mockExportFile]);

      const { result } = renderHook(() => useGeometryExport({ geometries: [gltfGeometry] }));

      await act(async () => {
        result.current.exportGeometry('stl');
      });

      expect(downloadBlob).toHaveBeenCalled();
    });

    it('should not throw on error when onError is not provided', async () => {
      vi.mocked(exportFromGlb).mockRejectedValue(new Error('fail'));

      const { result } = renderHook(() => useGeometryExport({ geometries: [gltfGeometry] }));

      await act(async () => {
        result.current.exportGeometry('stl');
      });

      expect(downloadBlob).not.toHaveBeenCalled();
    });

    it('should find gltf geometry from mixed format array', async () => {
      vi.mocked(exportFromGlb).mockResolvedValue([mockExportFile]);

      const { result } = renderHook(() =>
        useGeometryExport({
          geometries: [svgGeometry, gltfGeometry],
        }),
      );

      await act(async () => {
        result.current.exportGeometry('glb');
      });

      expect(exportFromGlb).toHaveBeenCalledWith(glbContent, 'glb');
    });

    it('should set isExporting to false after successful export', async () => {
      vi.mocked(exportFromGlb).mockResolvedValue([mockExportFile]);

      const { result } = renderHook(() => useGeometryExport({ geometries: [gltfGeometry] }));

      await act(async () => {
        result.current.exportGeometry('stl');
      });

      await waitFor(() => {
        expect(result.current.isExporting).toBe(false);
      });
    });

    it('should set isExporting to false after failed export', async () => {
      vi.mocked(exportFromGlb).mockRejectedValue(new Error('fail'));

      const { result } = renderHook(() => useGeometryExport({ geometries: [gltfGeometry], onError: vi.fn() }));

      await act(async () => {
        result.current.exportGeometry('stl');
      });

      await waitFor(() => {
        expect(result.current.isExporting).toBe(false);
      });
    });
  });
});
