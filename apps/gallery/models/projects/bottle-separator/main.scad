// Open-bottom bottle separator. All dimensions are in millimetres.

/* [Arrangement] */
// Honeycomb staggers hexagons. Inline aligns square cells in both directions.
layout = "Honeycomb"; // [Honeycomb, Inline]
// Number of rows from front to back.
rows = 3; // [1:1:12]
// Bottles in a full row. In a honeycomb, alternating rows hold one fewer.
bottles_per_row = 3; // [1:1:12]

/* [Bottle fit] */
// Widest outside diameter of the bottle body. Measure yours before printing.
bottle_diameter = 95; // [20:0.5:160]
// Free space from the bottle to each flat wall.
side_clearance = 1; // [0:0.1:5]
// Shared divider thickness when Bottle gap is zero.
wall_thickness = 2.4; // [1:0.1:6]
// Centered glass-to-glass gap. Zero uses Wall thickness. Otherwise allow both side clearances plus at least 1 mm of wall.
bottle_gap = 0; // [0:0.1:20]
// Height above the bath floor. Keep the upper rim on the straight bottle body.
guide_height = 65; // [15:1:160]

/* [Small bed printing] */
// Print one identical cell per bottle, then slide the joints together vertically. Print the test pair first.
output_part = "Whole rack"; // [Whole rack, Print one cell, Joint test pair, Modular layout]
// Space on each dovetail flank. Adjust after printing the test pair in the intended filament.
joint_clearance = 0.25; // [0.10:0.05:0.45]
// Usable rectangular bed dimensions, after allowing for brims, clips and edge margins.
bed_width = 180; // [30:1:500]
// Usable front-to-back dimension, measured after the same allowances.
bed_depth = 180; // [30:1:500]

/* [Hidden] */
// Use flat-to-flat dimensions so the bottle fit is identical in either layout.
module cell_outline(across_flats) {
    rotate(180 / sides)
        circle(d = across_flats / cos(180 / sides), $fn = sides);
}

hexagonal = layout == "Honeycomb";
sides = hexagonal ? 6 : 4;
opening = bottle_diameter + 2 * side_clearance;
// Rounding the difference avoids rejecting a 1 mm wall at decimal settings.
divider = bottle_gap == 0 ? wall_thickness : round((bottle_gap - 2 * side_clearance) * 1000) / 1000;
pitch = opening + divider;
row_pitch = hexagonal ? pitch * sin(60) : pitch;
epsilon = 0.02;

// Start the seven-cell cluster with a short row so its centre row is widest.
function staggered(r) = hexagonal && rows > 1 && r % 2 == 0;
function row_size(r) = staggered(r) ? max(1, bottles_per_row - 1) : bottles_per_row;
function cell_center(r, c) = [(c + (staggered(r) ? 0.5 : 0)) * pitch, r * row_pitch];

module cell_array() {
    for (r = [0 : rows - 1], c = [0 : row_size(r) - 1])
        translate(cell_center(r, c)) children();
}

module wall_network() {
    linear_extrude(guide_height)
        difference() {
            union() { cell_array() cell_outline(opening + 2 * divider); }
            cell_array() cell_outline(opening);
        }
}

// A pointed roof closes each flow window at 45 degrees. Continuous rims at
// two heights guide the glass, and the open base lets it sit on the bath floor.
module flow_window(span_limit = undef) {
    rim = min(guide_height / 5, 2 * divider);
    peak = guide_height - rim;
    face_width = opening * tan(180 / sides);
    full_span = min(0.36 * face_width, 0.4 * (peak - rim));
    half_span = is_undef(span_limit) ? full_span : min(full_span, span_limit);
    depth = divider + 2 * epsilon;

    translate([pitch / 2, 0, 0])
        rotate([90, 0, 90])
            linear_extrude(depth, center = true)
                polygon([[-half_span, rim], [half_span, rim],
                         [half_span, peak - half_span], [0, peak],
                         [-half_span, peak - half_span]]);
}

assert(divider >= 1, str("Bottle gap must be at least ", 2 * side_clearance + 1,
                         " mm for this clearance, or zero to use Wall thickness."));
echo(str("Cell opening ", opening, " mm; divider ", divider, " mm; centered bottle gap ",
         pitch - bottle_diameter, " mm; center spacing ", pitch, " mm."));

module whole_rack() {
    difference() {
        wall_network();
        cell_array()
            for (face = [0 : sides - 1])
                rotate(360 * face / sides) flow_window();
    }
}

// Each modular face owns half a divider. Facing cells have opposite local Y
// axes, so one layout of tongues (+Y) and grooves (-Y) mates on every side.
face_x = pitch / 2;
key_depth = 1.8;
key_neck = 1.3;  // half-widths
key_head = 2.5;
backing = 1.2;
pad_width = key_head + joint_clearance + backing;
pad_depth = max(divider / 2, key_depth + joint_clearance + backing);
key_y = opening / 2 * tan(180 / sides) - pad_width - 0.7;
window_limit = key_y - pad_width - 1;
coupon_half = pad_width + 1;

// Use the same trapezoid for the rail and the relieved socket. The extension
// behind the seam joins the rail to its cell and opens the mouth of the socket.
rail_points = [[-0.5, -key_neck], [0, -key_neck], [key_depth, -key_head],
               [key_depth, key_head], [0, key_neck], [-0.5, key_neck]];

module on_faces() {
    for (i = [0 : sides - 1])
        rotate(i * 360 / sides) translate([face_x, 0]) children();
}

module socket() {
    mirror([1, 0]) offset(delta = joint_clearance) polygon(rail_points);
}

module module_profile() {
    difference() {
        union() {
            difference() {
                cell_outline(pitch);
                cell_outline(opening);
            }
            intersection() {
                cell_outline(pitch);
                on_faces() translate([-pad_depth, -key_y - pad_width])
                    square([pad_depth, 2 * pad_width]);
            }
            on_faces() translate([0, key_y]) polygon(rail_points);
        }
        on_faces() translate([0, -key_y]) socket();
    }
}

module print_cell() {
    difference() {
        linear_extrude(guide_height) module_profile();
        for (i = [0 : sides - 1])
            rotate(360 * i / sides) flow_window(window_limit);
    }
}

module joint_sample(side) {
    // Keep the same rail, groove and wall backing, on short flat strips.
    linear_extrude(min(12, guide_height)) {
        if (side == 1) union() {
            translate([-divider/2, -coupon_half]) square([divider/2, 2*coupon_half]);
            polygon(rail_points);
        } else difference() {
            translate([-pad_depth, -coupon_half]) square([pad_depth, 2*coupon_half]);
            socket();
        }
    }
}

function rotated(p, a) = [p.x*cos(a) - p.y*sin(a), p.x*sin(a) + p.y*cos(a)];
// The outside envelope consists of the original polygon plus the rail tips.
outline_points = [for (i = [0 : sides-1],
                   p = concat([[face_x, face_x * tan(180/sides)]],
                              [for (v = rail_points) [face_x+v.x, key_y+v.y]]))
                       rotated(p, i * 360/sides)];
function extent(points, axis) = max([for (p = points) p[axis]]) - min([for (p = points) p[axis]]);
cell_size = [extent(outline_points, 0), extent(outline_points, 1)];
module fit_bed(size) {
    straight = size.x <= bed_width && size.y <= bed_depth;
    turned = size.y <= bed_width && size.x <= bed_depth;
    assert(straight || turned, str("Part needs ", size.x, " x ", size.y,
           " mm before brim. Usable bed is ", bed_width, " x ", bed_depth, " mm."));
    rotate(straight ? 0 : 90) children();
}

module modular_output() {
    // Check the inner corner of the socket backing against the full circular
    // opening (bottle plus clearance), and keep the flow window off the rail.
    assert(window_limit > 1 && norm([face_x-pad_depth, key_y-pad_width]) >= opening/2,
           "Insufficient corner room for these keys. Increase divider thickness or use the whole rack.");
    if (output_part == "Joint test pair") {
        fit_bed([pad_depth + key_depth, 4*coupon_half + 3]) {
            joint_sample(1);
            translate([0, 2*coupon_half + 3]) joint_sample(-1);
        }
    } else if (output_part == "Print one cell") {
        fit_bed(cell_size) print_cell();
    } else {
        cell_array() print_cell();
    }
}

color([0.12, 0.55, 0.58])
    if (output_part == "Whole rack") whole_rack();
    else modular_output();
