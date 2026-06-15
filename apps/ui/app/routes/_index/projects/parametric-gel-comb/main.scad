/*
Parametric gel-comb style model inspired by the uploaded photo.
Units: millimeters.

v5 changes:
- Keeps the one-sided face ridges from v4.
- Text remains disabled by default.
- Keeps bottom_ridge_gap_from_teeth for spacing the lower ridge above the tooth roots.
- Adds adjustable angled side hooks / small end teeth.
- Adds independent tooth and bar thickness controls.
*/

$fn = 48;

// ---------- Teeth ----------
tooth_count         = 38;
tooth_length        = 20.0;
tooth_width         = 3.0;
tooth_thickness     = 0.7;
tooth_gap           = 1.5;
tooth_corner_radius = 0.35;

// ---------- Main body ----------
bar_thickness       = 1.0;    // Main bar sheet thickness, not counting raised ridge thickness
side_overhang       = 3.7;    // Extra body width beyond first/last tooth
bar_height          = 18.0;   // Height above the teeth
body_corner_radius  = 0.6;

// ---------- Rounded gaps/slots above the teeth ----------
slot_count          = 2;      // Change to 3 if you want three upper gaps
slot_height         = 3.0;
slot_width_manual   = 0;      // 0 = auto-fit; use a number for fixed repeated slot width
slot_gap            = 4.0;    // Distance between neighboring upper slots
slot_side_margin    = 6.0;    // End margin used only when slot_width_manual = 0
slot_center_y       = 9.8;    // Vertical slot location measured from tooth tops
slot_radius         = slot_height / 2;

// ---------- Optional side hooks / small angled end teeth ----------
show_side_hooks     = true;
hook_width          = 2.2;
hook_drop           = 6.0;
hook_attach_height  = 1.2;
hook_radius         = 0.4;

// Angle for the small hooks on the far left and far right.
// 0 = straight vertical.
// Positive = lower end leans outward, away from the center of the comb.
// Negative = lower end leans inward, toward the regular teeth.
hook_angle_degrees        = 8.0;
left_hook_angle_degrees   = hook_angle_degrees;
right_hook_angle_degrees  = hook_angle_degrees;

// Optional extra tip offset in millimeters, added after the angle is applied.
// Positive also moves the hook tip outward. Leave at 0 for angle-only control.
hook_tip_outward_extra    = 0.0;

// ---------- Optional raised ridge bands ----------
// These are the two horizontal raised bands like the photo: one along the top,
// and one near the bottom edge above the teeth.
//
// Important: by default only the FRONT ridge is enabled. That makes the ridge
// sit on one face instead of making a symmetric / centered bump through the part.
show_front_ridges       = true;
show_back_ridges        = false;   // Set true only if you want ridges on both faces

// Front/back thickness is the amount each ridge protrudes OUTWARD from its face.
front_ridge_thickness   = 0.20;    // Starts at Z = bar_thickness
back_ridge_thickness    = 0.20;    // Starts at Z = 0 and goes negative

// Top/bottom control the visible height of the ridge bands in Y.
top_ridge_height        = 1.0;
bottom_ridge_height     = 1.0;

// Vertical gap between the tooth tops/root line and the lower raised ridge.
// In this model the tooth tops meet the bar at Y = 0.
// So bottom_ridge_gap_from_teeth is the distance from Y = 0 to the bottom edge
// of the lower ridge band. Set to 0 to make the lower ridge touch the teeth.
bottom_ridge_gap_from_teeth      = 1.0;

// Set this larger than 0 if you want the raised strips to extend past the bar sides.
ridge_x_overhang        = 0.0;

// Keep ridges clipped to the comb shape, so they do not bridge over slots if
// you later move/resize the slots into a ridge band.
clip_ridges_to_comb_body = true;

// ---------- Optional raised front text ----------
// Text is disabled by default. Set show_labels = true to turn it back on.
show_labels         = false;
label_raise         = 0.25;
label_size          = 4.0;
label_y             = 14.1;
left_label          = str(tooth_count, " well");
middle_label        = "BIO-RAD";
right_label         = "1.0mm";
font_name           = "Liberation Sans:style=Bold";

// ---------- Calculated geometry ----------
tooth_pitch = tooth_width + tooth_gap;
teeth_span  = tooth_count * tooth_width + (tooth_count - 1) * tooth_gap;
bar_width   = teeth_span + 2 * side_overhang;
auto_slot_width = slot_count > 0
                  ? (bar_width - 2 * slot_side_margin - (slot_count - 1) * slot_gap) / slot_count
                  : 0;
slot_width  = slot_width_manual > 0 ? slot_width_manual : auto_slot_width;
slot_group_width = slot_count * slot_width + (slot_count - 1) * slot_gap;
slot_start_x = slot_width_manual > 0
               ? -slot_group_width / 2
               : -bar_width / 2 + slot_side_margin;
slot_y      = slot_center_y - slot_height / 2;
ridge_width = bar_width + 2 * ridge_x_overhang;

if (slot_count > 0 && slot_width <= 0)
    echo("WARNING: slot_width is <= 0. Increase side_overhang/bar_width or reduce slot_count/slot_gap/slot_side_margin.");
if (slot_count > 0 && slot_group_width > bar_width)
    echo("WARNING: slot group is wider than the bar. Reduce slot_count, slot_width_manual, or slot_gap.");
if (front_ridge_thickness < 0 || back_ridge_thickness < 0)
    echo("WARNING: ridge thickness values should be >= 0.");
if (tooth_thickness <= 0 || bar_thickness <= 0)
    echo("WARNING: tooth_thickness and bar_thickness should be > 0.");
if (bottom_ridge_gap_from_teeth < 0)
    echo("WARNING: bottom_ridge_gap_from_teeth should be >= 0.");
if (bottom_ridge_gap_from_teeth + bottom_ridge_height > bar_height)
    echo("WARNING: lower ridge is above the bar. Reduce bottom_ridge_gap_from_teeth or bottom_ridge_height.");
if (abs(left_hook_angle_degrees) > 30 || abs(right_hook_angle_degrees) > 30)
    echo("NOTE: side hook angles above about 30 degrees may look extreme or overlap nearby geometry.");

// 2D rounded rectangle, anchored at lower-left unless center=true.
module rounded_rect_2d(w, h, r = 0, center = false) {
    rr = min(r, min(w, h) / 2);
    if (rr <= 0) {
        square([w, h], center = center);
    } else {
        translate(center ? [-w / 2, -h / 2] : [0, 0])
            hull() {
                translate([rr,     rr])     circle(r = rr);
                translate([w - rr, rr])     circle(r = rr);
                translate([w - rr, h - rr]) circle(r = rr);
                translate([rr,     h - rr]) circle(r = rr);
            }
    }
}

module rounded_polygon_2d(points, r = 0) {
    safe_r = min(
        r,
        max(0, hook_width / 2 - 0.01),
        max(0, (hook_drop + hook_attach_height) / 2 - 0.01)
    );

    if (safe_r <= 0) {
        polygon(points = points);
    } else {
        // Gives the angled hook corners a small molded radius.
        offset(r = safe_r)
            offset(delta = -safe_r)
                polygon(points = points);
    }
}

module side_hook_2d(side = -1, angle_deg = 0, extra_outward = 0) {
    // side = -1 for left, +1 for right.
    // Positive angle/extra moves the bottom tip outward, away from center.
    hook_total_height = hook_drop + hook_attach_height;
    outward_tip_offset = hook_total_height * tan(angle_deg) + extra_outward;
    tip_shift_x = side * outward_tip_offset;

    outer_top_x    = side * bar_width / 2;
    inner_top_x    = outer_top_x - side * hook_width;
    outer_bottom_x = outer_top_x + tip_shift_x;
    inner_bottom_x = inner_top_x + tip_shift_x;

    // Keep points counter-clockwise for both sides.
    pts = side < 0
        ? [[outer_bottom_x, -hook_drop],
           [inner_bottom_x, -hook_drop],
           [inner_top_x, hook_attach_height],
           [outer_top_x, hook_attach_height]]
        : [[inner_bottom_x, -hook_drop],
           [outer_bottom_x, -hook_drop],
           [outer_top_x, hook_attach_height],
           [inner_top_x, hook_attach_height]];

    rounded_polygon_2d(pts, hook_radius);
}

module bar_outline_2d() {
    // Main upper bar.
    translate([-bar_width / 2, 0])
        rounded_rect_2d(bar_width, bar_height, body_corner_radius);
}

module teeth_outline_2d() {
    union() {
        // Downward teeth.
        for (i = [0 : tooth_count - 1])
            let (x = -teeth_span / 2 + i * tooth_pitch)
                translate([x, -tooth_length])
                    rounded_rect_2d(tooth_width, tooth_length + 0.1, tooth_corner_radius);

        // Small angled end hooks similar to the photo.
        if (show_side_hooks) {
            side_hook_2d(-1, left_hook_angle_degrees,  hook_tip_outward_extra);
            side_hook_2d( 1, right_hook_angle_degrees, hook_tip_outward_extra);
        }
    }
}

module comb_outline_2d() {
    union() {
        bar_outline_2d();
        teeth_outline_2d();
    }
}

module slot_cutouts_2d() {
    if (slot_count > 0) {
        for (i = [0 : slot_count - 1])
            let (x = slot_start_x + i * (slot_width + slot_gap))
                translate([x, slot_y])
                    rounded_rect_2d(slot_width, slot_height, slot_radius);
    }
}

module comb_face_2d() {
    difference() {
        comb_outline_2d();
        slot_cutouts_2d();
    }
}

module bar_face_2d() {
    difference() {
        bar_outline_2d();
        slot_cutouts_2d();
    }
}

module one_ridge_band_2d(y_center, strip_h) {
    if (strip_h > 0) {
        raw_band_width = ridge_width;
        raw_band_x = -raw_band_width / 2;
        raw_band_y = y_center - strip_h / 2;

        if (clip_ridges_to_comb_body) {
            intersection() {
                comb_face_2d();
                translate([raw_band_x, raw_band_y])
                    square([raw_band_width, strip_h]);
            }
        } else {
            difference() {
                translate([raw_band_x, raw_band_y])
                    square([raw_band_width, strip_h]);
                slot_cutouts_2d();
            }
        }
    }
}

module ridge_bands_2d() {
    union() {
        // Top ridge band.
        one_ridge_band_2d(
            bar_height - top_ridge_height / 2,
            top_ridge_height
        );

        // Bottom ridge band above the teeth.
        // Lower edge is bottom_ridge_gap_from_teeth above the tooth root line, Y = 0.
        one_ridge_band_2d(
            bottom_ridge_gap_from_teeth + bottom_ridge_height / 2,
            bottom_ridge_height
        );
    }
}

module face_ridges_3d(face = "front", thickness = 0.2) {
    if (thickness > 0) {
        // One-sided placement:
        // front: sits on +Z face and goes outward
        // back : sits on -Z face and goes outward in negative Z
        z_start = face == "front" ? bar_thickness : -thickness;

        translate([0, 0, z_start])
            linear_extrude(height = thickness, convexity = 10)
                ridge_bands_2d();
    }
}

module raised_text_3d(txt, x, y, size) {
    // Text is placed on the front face only. If there is a front ridge under it,
    // the union will merge it naturally.
    translate([x, y, bar_thickness])
        linear_extrude(height = label_raise)
            text(txt, size = size, halign = "center", valign = "center", font = font_name);
}

module face_details_3d() {
    if (show_front_ridges)
        face_ridges_3d("front", front_ridge_thickness);

    if (show_back_ridges)
        face_ridges_3d("back", back_ridge_thickness);

    if (show_labels) {
        raised_text_3d(left_label,   -bar_width * 0.28, label_y, label_size);
        raised_text_3d(middle_label,  0,                label_y, label_size * 0.82);
        raised_text_3d(right_label,   bar_width * 0.28, label_y, label_size);
    }
}

module gel_comb() {
    union() {
        linear_extrude(height = bar_thickness, convexity = 10)
            bar_face_2d();
        linear_extrude(height = tooth_thickness, convexity = 10)
            teeth_outline_2d();
        face_details_3d();
    }
}

gel_comb();
