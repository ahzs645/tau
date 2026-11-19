import { createHash } from 'node:crypto';
import type { GeoSpecCanonicalClaimReport } from 'geospec/assertion-client';
import { z } from 'zod';
import { normalizeStaticGlb } from '#runtime/static-glb.js';

export const printabilityEvidenceSchema = z.object({
  binding: z.enum(['napi', 'wasm']),
  subjectHash: z.string(),
  sourceSha256: z.string(),
  sourceCoordinateSystem: z.literal('y-up'),
  admittedCoordinateSystem: z.literal('z-up'),
  admittedSha256: z.string(),
  sourceUnit: z.literal('m'),
  expectedComponents: z.number().int().positive(),
  toleranceMm: z.literal(0.001),
  claims: z.array(
    z.object({
      matcher: z.string(),
      status: z.string(),
      canonicalClaim: z.string(),
      canonicalPlan: z.string(),
      canonicalResult: z.string(),
    }),
  ),
});

export type PrintabilityEvidence = z.infer<typeof printabilityEvidenceSchema>;

const admissionSchema = z.object({ result: z.object({ subject: z.object({ subjectHash: z.string() }) }) });
const protocol = { canonicalProfile: 'geospec-jcs-v1', protocolVersion: 3, registryVersion: 5 } as const;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Evaluate retained bottle printability requirements on the exact viewer bytes in the compiled owner. */
export const verifyPrintability = async (
  bytes: Uint8Array<ArrayBuffer>,
  expectedComponents: number,
): Promise<PrintabilityEvidence> => {
  // GeoSpec 0.6 refuses Y-up admission. Reorient scene roots while preserving every binary chunk and extension.
  const admittedBytes = normalizeStaticGlb(bytes, 'y-up', 'z-up');
  const [
    { createGeoSpecAssertionClient, GeoSpecAssertionError },
    { encodeGeoSpecCanonicalJson },
    { createNodeGeoSpecEngine },
  ] = await Promise.all([import('geospec/assertion-client'), import('geospec/engine'), import('geospec/runner/node')]);
  const runClaim = (invoke: () => GeoSpecCanonicalClaimReport): GeoSpecCanonicalClaimReport => {
    try {
      return invoke();
    } catch (error) {
      if (error instanceof GeoSpecAssertionError) {
        // Failed, refused and unsupported evidence stays visible; none becomes a geometric pass.
        return error.report;
      }
      throw error;
    }
  };
  const { engine, binding } = await createNodeGeoSpecEngine({ executionPermits: 1, factsStore: false });
  try {
    engine.processRequest(
      encodeGeoSpecCanonicalJson({ ...protocol, method: 'initialize', requestId: 'gallery-initialize' }),
    );
    const admitted = admissionSchema.parse(
      JSON.parse(
        decoder.decode(
          engine.ingestSubject(
            encodeGeoSpecCanonicalJson({
              ...protocol,
              method: 'ingestSubject',
              requestId: 'gallery-bottle',
              format: 'glb',
              frame: { coordinateSystem: 'z-up', sourceUnit: 'm', outputUnit: 'mm' },
              ingestOptions: {},
              primaryByteLength: admittedBytes.byteLength,
              resources: [],
            }),
            admittedBytes,
            [],
          ),
        ),
      ),
    );
    const { subjectHash } = admitted.result.subject;
    const client = createGeoSpecAssertionClient({ engine, evidenceProfile: 'bounded' });
    const reports = [
      { matcher: 'toBeWatertight', report: runClaim(() => client.expectGeo({ subjectHash }).toBeWatertight()) },
      {
        matcher: 'toHaveConnectedComponents',
        report: runClaim(() =>
          client
            .expectGeo({ subjectHash })
            .toHaveConnectedComponents({ count: expectedComponents, toleranceMm: 0.001 }),
        ),
      },
    ];
    return {
      binding,
      subjectHash,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      sourceCoordinateSystem: 'y-up',
      admittedCoordinateSystem: 'z-up',
      admittedSha256: createHash('sha256').update(admittedBytes).digest('hex'),
      sourceUnit: 'm',
      expectedComponents,
      toleranceMm: 0.001,
      claims: reports.map(({ matcher, report }) => ({
        matcher,
        status: report.status,
        canonicalClaim: decoder.decode(report.canonicalClaim),
        canonicalPlan: decoder.decode(report.canonicalPlan),
        canonicalResult: decoder.decode(report.canonicalResult),
      })),
    };
  } finally {
    engine.close();
  }
};
