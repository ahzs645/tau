$fn = 48;

tooth_count = 28;
tooth_length = 20;
tooth_width = 3;
tooth_thickness = 0.8;
tooth_gap = 1.5;
bar_height = 18;
bar_thickness = 1.2;
side_overhang = 4;
slot_count = 2;
slot_height = 3;
slot_gap = 4;
slot_side_margin = 6;
show_side_hooks = true;

comb_width = tooth_count * tooth_width + (tooth_count - 1) * tooth_gap + side_overhang * 2;
slot_width = (comb_width - slot_side_margin * 2 - (slot_count - 1) * slot_gap) / slot_count;

module rounded_box(size, r = 0.4) {
  linear_extrude(height = size[2])
    offset(r = r)
      offset(delta = -r)
        square([size[0], size[1]], center = true);
}

module slot_cutout(x) {
  translate([x, bar_height * 0.58, -1])
    linear_extrude(height = bar_thickness + 2)
      hull() {
        translate([-slot_width / 2 + slot_height / 2, 0])
          circle(d = slot_height);
        translate([slot_width / 2 - slot_height / 2, 0])
          circle(d = slot_height);
      }
}

module comb_body() {
  difference() {
    translate([0, bar_height / 2, 0])
      rounded_box([comb_width, bar_height, bar_thickness], 0.6);

    for (i = [0 : slot_count - 1]) {
      x = -comb_width / 2 + slot_side_margin + slot_width / 2 + i * (slot_width + slot_gap);
      slot_cutout(x);
    }
  }
}

module tooth(x) {
  translate([x, -tooth_length / 2, 0])
    rounded_box([tooth_width, tooth_length, tooth_thickness], 0.25);
}

union() {
  comb_body();

  start_x = -comb_width / 2 + side_overhang + tooth_width / 2;
  for (i = [0 : tooth_count - 1])
    tooth(start_x + i * (tooth_width + tooth_gap));

  if (show_side_hooks) {
    translate([-comb_width / 2 + 1, -5, 0])
      rotate([0, 0, -8])
        rounded_box([2.2, 12, tooth_thickness], 0.25);
    translate([comb_width / 2 - 1, -5, 0])
      rotate([0, 0, 8])
        rounded_box([2.2, 12, tooth_thickness], 0.25);
  }
}