$fn = 32;

rack_width = 120;
rack_depth = 80;
rack_height = 100;
wall_thickness = 2;
poe_switch_width = 100;
poe_switch_height = 25;
patch_panel_width = 100;
patch_panel_height = 20;
vent_hole_size = 3;
vent_spacing = 8;

module side_vents(x) {
  for (y = [18 : vent_spacing : rack_depth - 18])
    for (z = [15 : vent_spacing : rack_height - 15])
      translate([x, y, z])
        rotate([0, 90, 0])
          cylinder(d = vent_hole_size, h = wall_thickness + 2, center = true, $fn = 8);
}

module networking_rack() {
  difference() {
    cube([rack_width, rack_depth, rack_height]);

    translate([wall_thickness, wall_thickness, wall_thickness])
      cube([
        rack_width - 2 * wall_thickness,
        rack_depth - 2 * wall_thickness,
        rack_height,
      ]);

    translate([(rack_width - poe_switch_width) / 2, -1, 20])
      cube([poe_switch_width, wall_thickness + 2, poe_switch_height]);

    translate([(rack_width - patch_panel_width) / 2, -1, 50])
      cube([patch_panel_width, wall_thickness + 2, patch_panel_height]);

    translate([rack_width / 4, rack_depth - wall_thickness - 1, 30])
      cube([10, wall_thickness + 2, 8]);

    translate([3 * rack_width / 4 - 10, rack_depth - wall_thickness - 1, 30])
      cube([10, wall_thickness + 2, 8]);

    side_vents(wall_thickness / 2);
    side_vents(rack_width - wall_thickness / 2);
  }

  translate([wall_thickness, wall_thickness, 20 + poe_switch_height + 2])
    cube([rack_width - 2 * wall_thickness, rack_depth - 2 * wall_thickness, 2]);

  translate([wall_thickness, wall_thickness, 50 + patch_panel_height + 2])
    cube([rack_width - 2 * wall_thickness, rack_depth - 2 * wall_thickness, 2]);
}

networking_rack();