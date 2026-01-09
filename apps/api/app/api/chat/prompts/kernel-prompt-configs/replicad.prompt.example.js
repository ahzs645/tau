/**
 * Parametric Watering Can
 * Comprehensive Replicad example demonstrating the full Resilient Modeling Strategy
 *
 * Features demonstrated:
 * - Reference: Real-world dimensions with parametric defaults
 * - Core: Revolve for main body, loft for spout
 * - Surface: smoothSpline for organic curves, tangentArcTo
 * - Detail: Decorative hole pattern, drainage
 * - Modify: fuse (boolean union), cut (boolean difference)
 * - Quarantine: fillet for edges, chamfer for rim, shell for hollow
 */
import { makePlane, draw, drawCircle } from 'replicad';

// === PARAMETERS (Reference features - real-world dimensions) ===
export const defaultParams = {
  // Body dimensions
  bodyHeight: 120,           // mm - standard watering can height
  beltlineDiameter: 90,      // mm - widest point diameter
  
  // Spout dimensions
  spoutDiameter: 12,         // mm - water flow outlet
  spoutAngle: 25,            // degrees - spout tilt from vertical
  
  // Construction
  wallThickness: 2.5,        // mm - suitable for 3D printing
  
  // Features
  decorativeHoles: true,     // add ventilation/drainage pattern
  holeCount: 6,              // number of decorative holes
  holeDiameter: 8,           // mm - size of each hole
};

export default function main(p = defaultParams) {
  // === CORE FEATURES: Main body profile ===
  // Create organic profile using smoothSpline (Surface feature)
  const profile = draw()
    .hLine(p.beltlineDiameter / 5)
    // First curve: base to beltline (widest point)
    .smoothSplineTo([p.beltlineDiameter / 2.1, p.bodyHeight / 2.5], {
      endTangent: [0.2, 1],
      endFactor: 1.5,
    })
    // Second curve: beltline to shoulder
    .smoothSplineTo([p.beltlineDiameter / 3, p.bodyHeight / 1.1], {
      endTangent: [0, 1],
    })
    // Top rim with tangent arc
    .tangentArcTo([p.beltlineDiameter / 4, p.bodyHeight])
    .hLine(-p.beltlineDiameter / 4)
    .close();

  // Revolve to create main body (Core feature)
  let body = profile.sketchOnPlane("XZ").revolve([0, 0, 1]);

  // === SURFACE FEATURES: Spout via loft ===
  // Create spout using loft between circles at different planes
  const spoutTopPlane = makePlane()
    .pivot(-p.spoutAngle, "Y")
    .translate([-p.beltlineDiameter / 2.5, 0, p.bodyHeight * 1.15]);
  
  const spoutTop = drawCircle(p.spoutDiameter)
    .sketchOnPlane(spoutTopPlane);
  
  const spoutBase = drawCircle(p.spoutDiameter * 0.9)
    .sketchOnPlane("XY", p.bodyHeight * 0.85);
  
  const spout = spoutTop.loftWith([spoutBase], { ruled: false });
  
  // === MODIFY FEATURES: Boolean union ===
  body = body.fuse(spout);

  // === QUARANTINE FEATURES: Fillets and shell ===
  // Fillet the spout-to-body transition
  body = body.fillet(12, (e) => e.inPlane("XY", p.bodyHeight * 0.85));

  // Shell to create hollow interior (Quarantine feature)
  body = body.shell(p.wallThickness, (f) => 
    f.either([
      (face) => face.containsPoint([0, 0, p.bodyHeight]),
      (face) => face.containsPoint([-p.beltlineDiameter / 2.5, 0, p.bodyHeight * 1.15]),
    ])
  );

  // === DETAIL FEATURES: Decorative hole pattern ===
  if (p.decorativeHoles) {
    for (let i = 0; i < p.holeCount; i++) {
      const angle = (i * Math.PI * 2) / p.holeCount;
      const holeX = Math.cos(angle) * (p.beltlineDiameter / 2.8);
      const holeY = Math.sin(angle) * (p.beltlineDiameter / 2.8);
      const holeZ = p.bodyHeight / 2;
      
      // Create hole cylinder oriented radially
      const hole = drawCircle(p.holeDiameter / 2)
        .sketchOnPlane("XY", holeZ)
        .extrude(p.wallThickness * 3);
      
      body = body.cut(hole.translate([holeX, holeY, 0]));
    }
  }

  // === QUARANTINE FEATURES: Chamfer rim ===
  try {
    body = body.chamfer(1.5, (e) => e.inPlane("XY", p.bodyHeight));
  } catch (e) {
    // Chamfer may fail on complex geometry, continue without
    console.warn("Chamfer failed, continuing without rim chamfer");
  }

  return body;
}

