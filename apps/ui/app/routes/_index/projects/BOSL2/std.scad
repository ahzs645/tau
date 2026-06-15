// Minimal BOSL2 compatibility shim for bundled gallery models.
// It implements only the helpers used by the imported OpenSCAD projects.

CENTER = [0, 0, 0];
BOTTOM = [0, 0, -1];
TOP = [0, 0, 1];
LEFT = [-1, 0, 0];
RIGHT = [1, 0, 0];
FRONT = [0, -1, 0];
BACK = [0, 1, 0];

module up(z=0) {
    translate([0, 0, z]) children();
}

module down(z=0) {
    translate([0, 0, -z]) children();
}

module attach(anchor=CENTER) {
    children();
}

module cuboid(size=[1, 1, 1], anchor=CENTER) {
    center = anchor == CENTER;
    translate(center ? [0, 0, 0] : [0, 0, size[2] / 2])
        cube(size, center=true);
    children();
}

module xcyl(h=1, r=1, anchor=CENTER) {
    center = anchor == CENTER;
    translate(center ? [0, 0, 0] : [h / 2, 0, 0])
        rotate([0, 90, 0])
            cylinder(h=h, r=r, center=true);
}

