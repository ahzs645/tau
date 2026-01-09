/**
 * Parametric Gearbox Housing
 * Comprehensive JSCAD example demonstrating the full Resilient Modeling Strategy
 *
 * Features demonstrated:
 * - Reference: Real-world dimensions (M5 bolts, standard shaft sizes)
 * - Core: primitives (cylinder, cuboid), hull for rounded corners
 * - Surface: extrudeRotate for bearing bore, polygon for profiles
 * - Detail: Bolt pattern, shaft bore, mounting flange
 * - Modify: Boolean operations (union, subtract)
 * - Quarantine: colorize for visualization
 */

import { primitives, booleans, extrusions, transforms, hulls, colors } from '@jscad/modeling';

const { cylinder, cuboid, polygon } = primitives;
const { union, subtract } = booleans;
const { extrudeLinear, extrudeRotate } = extrusions;
const { translate, rotateZ } = transforms;
const { hull } = hulls;
const { colorize } = colors;

// === PARAMETERS (Reference features - real-world dimensions) ===
export const defaultParams = {
  // Housing dimensions
  housingWidth: 80,         // mm - overall width
  housingDepth: 60,         // mm - overall depth
  housingHeight: 40,        // mm - overall height
  wallThickness: 3,         // mm - wall thickness
  
  // Shaft specifications
  shaftDiameter: 10,        // mm - main shaft diameter (standard 10mm)
  bearingWidth: 5,          // mm - bearing seat width
  
  // Mounting hardware (M5 standard)
  boltDiameter: 5.5,        // mm - M5 clearance hole
  boltPattern: 4,           // number of mounting bolts
  
  // Design details
  cornerRadius: 5,          // mm - rounded corner radius
  flangeWidth: 10,          // mm - mounting flange extension
  flangeThickness: 5,       // mm - flange thickness
};

/**
 * Creates a rounded corner cylinder for hull operations
 * @param {object} p - Parameters
 * @returns Corner cylinder primitive
 */
function createCorner(p) {
  return cylinder({ radius: p.cornerRadius, height: p.housingHeight, segments: 32 });
}

/**
 * Creates the main housing body using hull for rounded corners (Core feature)
 * @param {object} p - Parameters
 * @returns Housing body geometry
 */
function createHousingBody(p) {
  const offset = p.cornerRadius;
  const halfW = p.housingWidth / 2 - offset;
  const halfD = p.housingDepth / 2 - offset;
  
  const corner = createCorner(p);
  
  // Position corners and hull them together
  const corners = [
    translate([halfW, halfD, 0], corner),
    translate([-halfW, halfD, 0], corner),
    translate([halfW, -halfD, 0], corner),
    translate([-halfW, -halfD, 0], corner),
  ];
  
  return hull(corners);
}

/**
 * Creates the interior cavity (Modify feature - boolean subtract)
 * @param {object} p - Parameters
 * @returns Interior cavity geometry
 */
function createInteriorCavity(p) {
  const offset = p.cornerRadius;
  const wallOffset = p.wallThickness;
  const halfW = p.housingWidth / 2 - offset - wallOffset;
  const halfD = p.housingDepth / 2 - offset - wallOffset;
  const cavityHeight = p.housingHeight - p.wallThickness;
  
  const corner = cylinder({ 
    radius: Math.max(p.cornerRadius - wallOffset, 1), 
    height: cavityHeight, 
    segments: 32 
  });
  
  const corners = [
    translate([halfW, halfD, p.wallThickness], corner),
    translate([-halfW, halfD, p.wallThickness], corner),
    translate([halfW, -halfD, p.wallThickness], corner),
    translate([-halfW, -halfD, p.wallThickness], corner),
  ];
  
  return hull(corners);
}

/**
 * Creates the bearing bore using extrudeRotate (Surface feature)
 * @param {object} p - Parameters
 * @returns Bearing bore geometry
 */
function createBearingBore(p) {
  // Create bearing profile for revolve
  const innerR = p.shaftDiameter / 2;
  const outerR = innerR + 2;
  
  const bearingProfile = polygon({ 
    points: [
      [innerR, 0],
      [outerR, 0],
      [outerR, p.bearingWidth],
      [innerR, p.bearingWidth],
    ]
  });
  
  const bearing = extrudeRotate({ segments: 32 }, bearingProfile);
  
  return translate([0, 0, p.housingHeight - p.bearingWidth], bearing);
}

/**
 * Creates the shaft through-hole (Detail feature)
 * @param {object} p - Parameters
 * @returns Shaft hole geometry
 */
function createShaftHole(p) {
  return cylinder({ 
    radius: p.shaftDiameter / 2, 
    height: p.housingHeight + 2, 
    center: [0, 0, p.housingHeight / 2],
    segments: 32 
  });
}

/**
 * Creates mounting bolt pattern (Detail feature - circular pattern)
 * @param {object} p - Parameters
 * @returns Array of bolt hole geometries
 */
function createBoltPattern(p) {
  const boltHole = cylinder({ 
    radius: p.boltDiameter / 2, 
    height: p.wallThickness + 2, 
    segments: 16 
  });
  
  // Calculate bolt circle radius
  const boltRadius = Math.min(p.housingWidth, p.housingDepth) / 2 - p.cornerRadius - 5;
  
  const holes = [];
  for (let i = 0; i < p.boltPattern; i++) {
    const angle = (i / p.boltPattern) * Math.PI * 2;
    const x = boltRadius * Math.cos(angle);
    const y = boltRadius * Math.sin(angle);
    holes.push(translate([x, y, -1], boltHole));
  }
  
  return holes;
}

/**
 * Creates mounting flange (Detail feature - extrudeLinear)
 * @param {object} p - Parameters
 * @returns Flange geometry
 */
function createMountingFlange(p) {
  const flangeWidth = p.housingWidth + 2 * p.flangeWidth;
  const flangeDepth = p.flangeThickness;
  
  const flangeProfile = polygon({ 
    points: [
      [-flangeWidth / 2, 0],
      [flangeWidth / 2, 0],
      [flangeWidth / 2, flangeDepth],
      [-flangeWidth / 2, flangeDepth],
    ]
  });
  
  const flange = extrudeLinear({ height: p.wallThickness }, flangeProfile);
  
  return translate([0, -p.housingDepth / 2, 0], flange);
}

// === MAIN FUNCTION ===
export default function main(p = defaultParams) {
  // Core feature: Create housing body with rounded corners
  let housing = createHousingBody(p);
  
  // Modify feature: Hollow out interior
  const interior = createInteriorCavity(p);
  housing = subtract(housing, interior);
  
  // Surface feature: Add bearing bore
  const bearingBore = createBearingBore(p);
  housing = subtract(housing, bearingBore);
  
  // Detail feature: Add shaft through-hole
  const shaftHole = createShaftHole(p);
  housing = subtract(housing, shaftHole);
  
  // Detail feature: Add mounting bolt pattern
  const boltHoles = createBoltPattern(p);
  for (const hole of boltHoles) {
    housing = subtract(housing, hole);
  }
  
  // Detail feature: Add mounting flange
  const flange = createMountingFlange(p);
  housing = union(housing, flange);
  
  // Quarantine feature: Apply color for visualization
  return colorize([0.7, 0.7, 0.75], housing);
}

