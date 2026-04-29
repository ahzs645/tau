import type { GltfInspection } from './gltf-inspector.js';

export type BoundingBoxViewerProps = {
  readonly inspection: GltfInspection;
};

const fmt = (n: number): string => (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(3));
const vec = (v: readonly [number, number, number]): string => `[${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}]`;

export function BoundingBoxViewer({ inspection }: BoundingBoxViewerProps) {
  const { asset, counts, bbox } = inspection;
  return (
    <div data-testid='bbox-viewer' style={containerStyles}>
      <h3 style={sectionTitleStyles}>Bounding box</h3>
      <dl style={defListStyles}>
        <dt>min</dt>
        <dd data-testid='bbox-min'>{vec(bbox.min)}</dd>
        <dt>max</dt>
        <dd data-testid='bbox-max'>{vec(bbox.max)}</dd>
        <dt>size</dt>
        <dd data-testid='bbox-size'>{vec(bbox.size)}</dd>
        <dt>center</dt>
        <dd data-testid='bbox-center'>{vec(bbox.center)}</dd>
      </dl>
      <h3 style={sectionTitleStyles}>Counts</h3>
      <dl style={defListStyles}>
        <dt>meshes</dt>
        <dd data-testid='count-meshes'>{counts.meshes}</dd>
        <dt>primitives</dt>
        <dd data-testid='count-primitives'>{counts.primitives}</dd>
        <dt>vertices</dt>
        <dd data-testid='count-vertices'>{counts.vertices}</dd>
        <dt>triangles</dt>
        <dd data-testid='count-triangles'>{counts.triangles}</dd>
      </dl>
      <h3 style={sectionTitleStyles}>Asset</h3>
      <dl style={defListStyles}>
        <dt>version</dt>
        <dd data-testid='asset-version'>{asset.version}</dd>
        <dt>generator</dt>
        <dd data-testid='asset-generator'>{asset.generator ?? '\u2014'}</dd>
      </dl>
    </div>
  );
}

const containerStyles: React.CSSProperties = {
  fontSize: '0.85rem',
  fontFamily: 'ui-monospace, monospace',
  overflow: 'auto',
};

const sectionTitleStyles: React.CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 600,
  margin: '0.5rem 0 0.25rem',
  color: '#444',
};

const defListStyles: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '8ch 1fr',
  gap: '0.1rem 0.5rem',
  margin: 0,
};
