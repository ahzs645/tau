/*
  BOSL2 OpenSCAD starter model
  Approximate part: M14x1.25 external / M10x1.0 internal spark-plug-style
  pre-chamber / jet-nozzle insert.

  This version uses BOSL2's real helical ISO/UTS-style thread geometry
  instead of cosmetic ring grooves, includes a selector for original vs.
  corrected hex/collar dimensions, and adds angled side holes.

  Required library:
    BOSL2 installed in your OpenSCAD library path.

  BOSL2 includes used:
    include <BOSL2/std.scad>
    include <BOSL2/threading.scad>

  Notes:
  - This is reverse-engineering starter CAD only, not a production drawing.
  - Dimensions other than the provided threads/holes/hex/collar are estimated from photos.
  - For a live engine / combustion / pressure part, final geometry, material,
    heat treatment, tolerances, and inspection should be specified by a qualified
    engineer or machinist.
  - Metal AM threads this small usually still need post-machining/tapping/chasing.

  Known from supplied notes/photos:
  - External thread: M14 x 1.25
  - Internal thread: M10 x 1.0, approx. 19 mm deep
  - Holes at nozzle end: one axial 2.5 mm, one side 2.5 mm, two side 1.0 mm
  - Side holes are angled about 30 degrees from horizontal.

  Customer correction from email:
  - Earlier/wrong hex: 3/4 inch across flats = 19.05 mm
  - Corrected hex: 5/8 inch across flats = 15.875 mm
  - Corrected round collar immediately below hex: 0.73 inch OD = 18.542 mm

  Coordinate system:
  - Z=0 is the conical nozzle/tip end.
  - Positive Z goes toward the hex/internal-thread end.

  Side-hole angle convention:
  - The side-hole cut starts near the center/pre-chamber and extends outward.
  - side_hole_tilt_direction = "toward_tip" means the outside opening is tilted
    toward Z=0 as it exits the part.
  - side_hole_tilt_direction = "toward_hex" means the outside opening is tilted
    toward the hex/internal-thread end as it exits the part.
  - side_hole_tilt_direction = "horizontal" gives the previous straight radial holes.
*/

include <BOSL2/std.scad>
include <BOSL2/threading.scad>

$fn = 96;
$fa = 1;
$fs = 0.25;

// -------------------------
// User-adjustable dimensions
// -------------------------

/* [Dimension preset] */
// Choose which hex/collar dimensions to use. Corrected uses 5/8" hex and 0.73" collar OD.
dimension_preset = "corrected"; // [original, corrected]

/* [Threads] */
// Toggle true BOSL2 threads vs. plain cylinders. Leave true for thread model.
model_external_thread = true;
model_internal_thread = true;

// Thread clearance/slop. Normally 0 for reference/CNC models.
external_thread_slop = 0.00;
internal_thread_slop = 0.00;

/* [Main envelope - estimated unless measured] */
overall_len        = 35.0;       // total length, mm; estimated from tape photos
nose_len           = 7.0;        // conical nose length, mm; estimated
threaded_len       = 21.5;       // external M14 threaded section length, mm; estimated
collar_h           = 2.8;        // round shoulder/collar height, mm; estimated

/* [Tip / chamber - estimated unless measured] */
nose_tip_flat_d    = 5.8;        // diameter of flat at conical tip around axial hole; estimated
prechamber_d       = 5.5;        // estimated internal chamber diameter
prechamber_start_z = 2.2;        // axial tip hole opens into chamber here; estimated

/* [Holes] */
axial_hole_d       = 2.5;
side_large_d       = 2.5;
side_small_d       = 1.0;

// side_hole_z is the approximate intersection point with the center/pre-chamber.
// With angled holes, the outside opening will appear closer to the tip or hex
// depending on side_hole_tilt_direction.
side_hole_z        = 4.2;        // side-hole centerline start Z; estimated
side_hole_cut_len  = 14.0;       // long enough to pass through cone after tilting

// Side holes are reportedly angled about 30 degrees from horizontal.
side_hole_tilt_from_horizontal = 30;       // degrees
side_hole_tilt_direction       = "toward_tip"; // [toward_tip, toward_hex, horizontal]

// Hole clocking around the cone. Adjust these after inspecting the sample.
large_side_angle   = 0;
small_side_angle_1 = 120;
small_side_angle_2 = 240;

/* [Hidden] */
inch = 25.4;
eps = 0.03;

// -------------------------
// Preset-controlled dimensions
// -------------------------

// Earlier/wrong dimensions from first interpretation.
hex_af_original    = 3/4 * inch;     // 19.05 mm across flats
collar_d_original  = 21.5;           // mm, original photo-based estimate

// Corrected dimensions from customer email.
hex_af_corrected   = 5/8 * inch;     // 15.875 mm across flats
collar_d_corrected = 0.73 * inch;    // 18.542 mm OD

// Active dimensions used by the model.
hex_af             = (dimension_preset == "corrected") ? hex_af_corrected : hex_af_original;
collar_d           = (dimension_preset == "corrected") ? collar_d_corrected : collar_d_original;

// Derived height. Change overall_len, nose_len, threaded_len, or collar_h if measured.
hex_h              = overall_len - nose_len - threaded_len - collar_h;

// Derived value for reference/debugging. OpenSCAD 6-sided cylinder diameter is corner-to-corner.
hex_vertex_d       = 2 * hex_af / sqrt(3);

// Convert the user-facing tilt setting into the signed CAD elevation angle.
// Positive elevation means outward/toward hex. Negative elevation means outward/toward tip.
side_hole_elevation_deg =
    (side_hole_tilt_direction == "toward_hex") ? side_hole_tilt_from_horizontal :
    (side_hole_tilt_direction == "toward_tip") ? -side_hole_tilt_from_horizontal :
    0;

// Echo active preset/dimensions in the OpenSCAD console.
echo(str("dimension_preset = ", dimension_preset));
echo(str("hex_af = ", hex_af, " mm"));
echo(str("hex_vertex_d = ", hex_vertex_d, " mm"));
echo(str("collar_d = ", collar_d, " mm"));
echo(str("side_hole_tilt_direction = ", side_hole_tilt_direction));
echo(str("side_hole_elevation_deg = ", side_hole_elevation_deg, " degrees"));

// -------------------------
// Thread dimensions
// -------------------------

// External M14x1.25 thread section.
ext_thread_major_d = 14.0;       // M14 nominal major OD
ext_thread_pitch   = 1.25;

// Internal M10x1.0 thread section.
int_thread_major_d = 10.0;       // M10 nominal major diameter of mating male thread
int_thread_pitch   = 1.0;
int_thread_depth   = 19.0;       // supplied approximate thread depth

// Bore used if true helical internal thread is disabled; also used for small reliefs.
plain_int_bore_d   = 8.8;        // approximate M10x1 tap drill/minor bore reference

// Internal pre-chamber relationship to rear thread.
int_thread_start_z = overall_len - int_thread_depth;
prechamber_end_z   = int_thread_start_z + 0.6;  // slight overlap into rear thread cut

// -------------------------
// Helpers
// -------------------------

module hex_prism_af(af, h) {
    // OpenSCAD cylinder(d=..., $fn=6) uses vertex-to-vertex diameter.
    // Across-flats = sqrt(3) * radius, so vertex diameter = 2*AF/sqrt(3).
    vertex_d = 2 * af / sqrt(3);
    rotate([0, 0, 30]) cylinder(h=h, d=vertex_d, $fn=6);
}

module external_M14_thread(len) {
    if (model_external_thread) {
        // BOSL2 UTS/ISO 60-degree helical thread.
        // anchor=BOTTOM makes the part start at local Z=0.
        threaded_rod(
            d=ext_thread_major_d,
            l=len,
            pitch=ext_thread_pitch,
            anchor=BOTTOM,
            blunt_start=false,
            bevel=false,
            $slop=external_thread_slop
        );
    } else {
        cylinder(h=len, d=ext_thread_major_d);
    }
}

module internal_M10_thread_cut(depth) {
    start_z = overall_len - depth;

    if (model_internal_thread) {
        // BOSL2 internal thread mask. This is subtracted from the body.
        // It extends a bit past the open end and overlaps the pre-chamber cut.
        translate([0, 0, start_z - eps])
            threaded_rod(
                d=int_thread_major_d,
                l=depth + 2*eps,
                pitch=int_thread_pitch,
                internal=true,
                anchor=BOTTOM,
                blunt_start=false,
                bevel=false,
                $slop=internal_thread_slop
            );
    } else {
        translate([0, 0, start_z - eps])
            cylinder(h=depth + 2*eps, d=plain_int_bore_d);
    }
}

module angled_radial_hole_from_center(d, z, azimuth_deg, elevation_deg, cut_len) {
    /*
      Side-hole cutter.

      Starts near the center/pre-chamber at local Z=z, then cuts one side outward.
      elevation_deg is the angle from horizontal/radial:
        0    = previous horizontal radial hole
        +30  = exits upward in +Z, toward the hex end
        -30  = exits downward in -Z, toward the conical tip end

      Rotation math:
      - A cylinder begins along local +Z.
      - rotate([0, 90-elevation_deg, 0]) aims that cylinder mostly along +X,
        with the requested vertical Z component.
      - rotate([0, 0, azimuth_deg]) clocks that angled hole around the part.
    */
    rotate([0, 0, azimuth_deg])
        translate([0, 0, z])
            rotate([0, 90 - elevation_deg, 0])
                translate([0, 0, -0.60])
                    cylinder(h=cut_len + 0.60, d=d, $fn=max(24, ceil(d*24)));
}

module rear_mouth_chamfer_cut() {
    // Slight rear lead-in/chamfer at internal bore mouth, matching the photos roughly.
    translate([0, 0, overall_len - 1.1])
        cylinder(h=1.4, d1=int_thread_major_d + 1.7, d2=int_thread_major_d + 0.3, $fn=72);
}

// Optional visual reference for checking hole directions before rendering/exporting.
// Set show_hole_axis_guides=true at the bottom section if you want to see thin rods
// along the side-hole axes. Keep false for STL export/manufacturing geometry.
module hole_axis_guide(z, azimuth_deg, elevation_deg, guide_len=15) {
    rotate([0, 0, azimuth_deg])
        translate([0, 0, z])
            rotate([0, 90 - elevation_deg, 0])
                translate([0, 0, -0.60])
                    cylinder(h=guide_len, d=0.35, $fn=16);
}

// -------------------------
// Positive outer body
// -------------------------

module positive_body() {
    union() {
        // Conical nozzle end.
        cylinder(h=nose_len, d1=nose_tip_flat_d, d2=ext_thread_major_d);

        // M14x1.25 external threaded body.
        translate([0, 0, nose_len])
            external_M14_thread(threaded_len);

        // Round collar immediately below the hex.
        translate([0, 0, nose_len + threaded_len])
            cylinder(h=collar_h, d=collar_d);

        // Hex end. AF size is controlled by dimension_preset.
        translate([0, 0, nose_len + threaded_len + collar_h])
            hex_prism_af(hex_af, hex_h);
    }
}

// -------------------------
// Subtractive holes / bores
// -------------------------

module subtractive_features() {
    // 2.5 mm axial tip/orifice hole.
    translate([0, 0, -eps])
        cylinder(h=prechamber_start_z + 2*eps, d=axial_hole_d, $fn=48);

    // Internal pre-chamber behind the axial tip orifice.
    translate([0, 0, prechamber_start_z])
        cylinder(h=prechamber_end_z - prechamber_start_z, d=prechamber_d, $fn=72);

    // Rear M10x1.0 internal thread, approx. 19 mm deep.
    internal_M10_thread_cut(int_thread_depth);

    // Angled side holes in/near the conical nozzle end.
    angled_radial_hole_from_center(side_large_d, side_hole_z, large_side_angle,   side_hole_elevation_deg, side_hole_cut_len);
    angled_radial_hole_from_center(side_small_d, side_hole_z, small_side_angle_1, side_hole_elevation_deg, side_hole_cut_len);
    angled_radial_hole_from_center(side_small_d, side_hole_z, small_side_angle_2, side_hole_elevation_deg, side_hole_cut_len);

    // Rear bore lead-in.
    rear_mouth_chamfer_cut();
}

// -------------------------
// Final model
// -------------------------

if (hex_h <= 0) {
    echo("WARNING: hex_h is <= 0. Increase overall_len or reduce nose_len/threaded_len/collar_h.");
}

if (dimension_preset != "original" && dimension_preset != "corrected") {
    echo("WARNING: dimension_preset should be 'original' or 'corrected'. Defaulting numerically to original behavior.");
}

if (side_hole_tilt_direction != "toward_tip" && side_hole_tilt_direction != "toward_hex" && side_hole_tilt_direction != "horizontal") {
    echo("WARNING: side_hole_tilt_direction should be 'toward_tip', 'toward_hex', or 'horizontal'. Defaulting numerically to horizontal behavior.");
}

show_hole_axis_guides = false;

difference() {
    positive_body();
    subtractive_features();
}

if (show_hole_axis_guides) {
    // Red/transparent guide rods show the intended side-hole centerlines.
    // These are outside the difference() so they are visual helpers only.
    color([1, 0, 0, 0.45]) {
        hole_axis_guide(side_hole_z, large_side_angle,   side_hole_elevation_deg);
        hole_axis_guide(side_hole_z, small_side_angle_1, side_hole_elevation_deg);
        hole_axis_guide(side_hole_z, small_side_angle_2, side_hole_elevation_deg);
    }
}
