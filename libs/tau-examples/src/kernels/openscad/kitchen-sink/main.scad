// Parameter Kitchen Sink
// Exercises every OpenSCAD Customizer parameter type.

/* [Dimensions] */
// Plain spinbox
height = 50;
// Spinbox with step
width = 25.5; // .5
// Slider with max
depth = 34; // [100]
// Slider with range
length = 50; // [10:200]
// Slider with step
count = 5; // [0:1:20]
// Centered slider
offset = 0; // [-10:0.1:10]

/* [Options] */
// Number dropdown
size = 20; // [10, 20, 30, 40]
// Labeled number dropdown
quality = 20; // [10:Low, 20:Medium, 30:High]
// String dropdown
material = "wood"; // [wood, metal, plastic, glass]
// Labeled string dropdown
finish = "M"; // [M:Matte, G:Glossy, S:Satin]
// Checkbox
show_base = true;
// Text string
label_text = "Hello";
// String with max length
serial = "ABC123"; //8

/* [Colors] */
// Color string
primary_color = "#FF6600";

/* [Vectors] */
// Vector2
position = [10, 20];
// Vector3
rotation = [0, 45, 90];
// Vector4
bounds = [0, 0, 100, 100];
// Vector with range
offsets = [5, 10, 15]; //[0:1:50]

/* [Hidden] */
_internal = 42;
$fn = 48;

module base_plate(w, d, h) {
  color(primary_color)
    translate([0, 0, h / 2])
      cube([w, d, h], center = true);
}

module pillar(r, h, pos) {
  translate([pos[0], pos[1], h / 2])
    cylinder(r = r, h = h, center = true);
}

module label_3d(txt, pos) {
  translate([pos[0], pos[1], height + 2])
    linear_extrude(2)
      text(txt, size = size / 4, halign = "center", valign = "center");
}

pillar_radius = width / 8;
base_h = depth / 10;

if (show_base) {
  base_plate(length, width, base_h);
}

for (i = [0 : 1 : count - 1]) {
  x = -length / 2 + length / (count + 1) * (i + 1) + offset;
  pillar(pillar_radius, height, [x, 0]);
}

rotate(rotation)
  translate(position)
    label_3d(label_text, [0, 0]);
