$fn = 64;

plate = [70, 38, 6];
post_radius = 8;
hole_radius = 3.2;

difference() {
  union() {
    translate([0, 0, plate[2] / 2])
      cube(plate, center = true);

    for (x = [-22, 22]) {
      translate([x, 0, plate[2]])
        cylinder(r = post_radius, h = 18);
    }
  }

  for (x = [-22, 22]) {
    translate([x, 0, -1])
      cylinder(r = hole_radius, h = 28);
  }

  translate([0, 0, plate[2] + 9])
    rotate([90, 0, 0])
      cylinder(r = 9, h = 50, center = true);
}