// Parametric Faucet Handle
// Comprehensive OpenSCAD example demonstrating the full Resilient Modeling Strategy
//
// Features demonstrated:
// - Reference: Parameters with real-world dimensions (M8, M12 standards)
// - Core: Prismatic base geometries (cylinder, hull)
// - Surface: rotate_extrude(), linear_extrude() with twist
// - Detail: Mounting hole, decorative elements
// - Modify: Boolean operations (difference, union)
// - Quarantine: minkowski() for edge fillets

// === PARAMETERS (Reference features - real-world dimensions) ===
// Grip parameters
grip_diameter = 35;          // mm - ergonomic grip size (typical 30-40mm)
grip_length = 40;            // mm - comfortable grip length
grip_twist = 30;             // degrees - ergonomic twist for grip texture

// Shaft parameters
shaft_diameter = 12;         // mm - M12 shaft standard
shaft_length = 15;           // mm - connection to valve stem

// Mounting hardware
mounting_hole = 8;           // mm - M8 bolt standard
mounting_depth = 25;         // mm - hole depth through shaft

// Finishing
fillet_radius = 2;           // mm - edge rounding for comfort
cap_diameter = 8;            // mm - decorative cap size

// Resolution
$fn = 64;                    // high resolution for smooth curves

// === MODULES (Core and Surface features) ===

// Fillet cylinder using minkowski sum (Quarantine feature)
// Creates rounded edges by adding sphere radius to cylinder
module fillet_cylinder(d, h, r) {
    minkowski() {
        cylinder(d = d - 2*r, h = h - 2*r);
        sphere(r = r);
    }
}

// Grip cross-section profile using hull (Core feature)
// Creates an oval-like ergonomic grip shape
module grip_profile() {
    hull() {
        translate([0, grip_diameter/4, 0])
            circle(d = grip_diameter/2);
        translate([0, -grip_diameter/4, 0])
            circle(d = grip_diameter/2);
    }
}

// Main handle assembly (Surface and Detail features)
module handle() {
    // Main grip with twist (Surface feature - linear_extrude with twist)
    linear_extrude(height = grip_length, twist = grip_twist, convexity = 4)
        grip_profile();
    
    // Shaft connection with fillets (Core + Quarantine features)
    translate([0, 0, -shaft_length])
        fillet_cylinder(d = shaft_diameter, h = shaft_length, r = fillet_radius);
    
    // Decorative cap (Detail feature - rotate_extrude for torus)
    translate([0, 0, grip_length])
        rotate_extrude(convexity = 4)
            translate([grip_diameter/6, 0, 0])
                circle(d = cap_diameter);
}

// === FINAL ASSEMBLY (Modify features - Boolean operations) ===
difference() {
    handle();
    
    // Mounting hole through shaft (Detail feature)
    translate([0, 0, -mounting_depth])
        cylinder(d = mounting_hole, h = mounting_depth + 5);
    
    // Valve stem socket (Detail feature)
    translate([0, 0, -shaft_length - 1])
        cylinder(d = shaft_diameter * 0.7, h = 10);
}

