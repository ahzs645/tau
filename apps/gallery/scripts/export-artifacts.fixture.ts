import { zipSync } from 'fflate';

type Point = readonly [number, number, number];
type Triangle = readonly [Point, Point, Point];

/** Build explicit STL records without using the decoder being tested. */
export const binaryStlFixture = (triangles: readonly Triangle[]): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(84 + triangles.length * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles.length, true);
  for (const [index, triangle] of triangles.entries()) {
    const offset = 84 + index * 50;
    view.setFloat32(offset + 8, 1, true);
    for (const [vertex, point] of triangle.entries()) {
      for (const [axis, value] of point.entries()) {
        view.setFloat32(offset + 12 + vertex * 12 + axis * 4, value, true);
      }
    }
  }
  return bytes;
};

/** Build readable STL records with independently specified millimetre coordinates. */
export const asciiStlFixture = (triangles: readonly Triangle[]): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(
    `solid fixture\n${triangles
      .map(
        (triangle) =>
          `facet normal 0 0 1\nouter loop\n${triangle.map((point) => `vertex ${point.join(' ')}`).join('\n')}\nendloop\nendfacet`,
      )
      .join('\n')}\nendsolid fixture\n`,
  );

export const wavefrontTriangleFixture = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 2 0\nf 1 2 3\n');

// A minimal physical-file structure fixture, not a certified or closed BRep solid.
export const triangleStepFixture = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Structural validation fixture'),'2;1');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=CARTESIAN_POINT('',(0.,2.,0.));
#4=POLY_LOOP('',(#1,#2,#3));
ENDSEC;
END-ISO-10303-21;`);

export const triangleModelXml = `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter">
<resources><object id="1" type="model"><mesh>
<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="2" z="0"/></vertices>
<triangles><triangle v1="0" v2="1" v3="2"/></triangles>
</mesh></object></resources><build><item objectid="1"/></build></model>`;

/** Package real ZIP manifests around a caller-specified 3MF model XML fixture. */
export const threeMfFixture = (model = triangleModelXml): Uint8Array<ArrayBuffer> => {
  const encoder = new TextEncoder();
  return new Uint8Array(
    zipSync({
      '[Content_Types].xml': encoder.encode(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
      ),
      '_rels/.rels': encoder.encode(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      ),
      '3D/3dmodel.model': encoder.encode(model),
    }),
  );
};
