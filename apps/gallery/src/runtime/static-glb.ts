const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate container boundaries before decoding or copying a GLB chunk. */
const readGlbJsonLength = (bytes: Uint8Array<ArrayBuffer>): number => {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 20 ||
    header.getUint32(0, true) !== 0x46_54_6c_67 ||
    header.getUint32(4, true) !== 2 ||
    header.getUint32(8, true) !== bytes.byteLength
  ) {
    throw new Error('The model preview is not a valid GLB version 2 file.');
  }
  const jsonLength = header.getUint32(12, true);
  if (header.getUint32(16, true) !== 0x4e_4f_53_4a || jsonLength % 4 !== 0 || jsonLength > bytes.byteLength - 20) {
    throw new Error('The model preview has an invalid GLB JSON chunk.');
  }
  let offset = 20 + jsonLength;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) {
      throw new Error('The model preview has a truncated GLB chunk.');
    }
    const length = header.getUint32(offset, true);
    if (length % 4 !== 0 || offset + 8 + length > bytes.byteLength) {
      throw new Error('The model preview has an invalid GLB chunk length.');
    }
    offset += 8 + length;
  }
  return jsonLength;
};

/**
 * Normalize scene axes at the container boundary without changing units. A parent node preserves animation,
 * embedded images, compressed geometry and application extensions. The viewer's default target is Y-up;
 * analysis tools may explicitly request the inverse transform into Z-up.
 */
export const normalizeStaticGlb = (
  bytes: Uint8Array<ArrayBuffer>,
  coordinateSystem: 'y-up' | 'z-up',
  targetCoordinateSystem: 'y-up' | 'z-up' = 'y-up',
): Uint8Array<ArrayBuffer> => {
  const jsonLength = readGlbJsonLength(bytes);
  if (coordinateSystem === targetCoordinateSystem) {
    return bytes;
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + jsonLength)),
  );
  if (!isRecord(parsed) || !Array.isArray(parsed['nodes']) || !Array.isArray(parsed['scenes'])) {
    throw new Error('The model preview has no glTF scene to orient.');
  }
  const nodes = parsed['nodes'].filter(isRecord);
  const scenes = parsed['scenes'].filter(isRecord);
  if (nodes.length !== parsed['nodes'].length || scenes.length !== parsed['scenes'].length) {
    throw new Error('The model preview contains an invalid glTF scene.');
  }
  const originalNodeCount = nodes.length;
  for (const scene of scenes) {
    const roots: unknown = scene['nodes'] ?? [];
    if (
      !Array.isArray(roots) ||
      roots.some(
        (node: unknown) => typeof node !== 'number' || !Number.isInteger(node) || node < 0 || node >= originalNodeCount,
      )
    ) {
      throw new Error('The model preview contains an invalid scene root.');
    }
    if (roots.length > 0) {
      const wrapper = nodes.length;
      nodes.push({
        name: 'Gallery coordinate system',
        rotation: [coordinateSystem === 'z-up' ? -Math.SQRT1_2 : Math.SQRT1_2, 0, 0, Math.SQRT1_2],
        children: roots,
      });
      scene['nodes'] = [wrapper];
    }
  }
  parsed['nodes'] = nodes;
  parsed['scenes'] = scenes;
  const json = new TextEncoder().encode(JSON.stringify(parsed));
  const paddedLength = Math.ceil(json.byteLength / 4) * 4;
  const rest = bytes.subarray(20 + jsonLength);
  const normalized = new Uint8Array(20 + paddedLength + rest.byteLength);
  const output = new DataView(normalized.buffer);
  output.setUint32(0, 0x46_54_6c_67, true);
  output.setUint32(4, 2, true);
  output.setUint32(8, normalized.byteLength, true);
  output.setUint32(12, paddedLength, true);
  output.setUint32(16, 0x4e_4f_53_4a, true);
  normalized.fill(0x20, 20, 20 + paddedLength);
  normalized.set(json, 20);
  normalized.set(rest, 20 + paddedLength);
  return normalized;
};
