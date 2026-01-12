// CSG Modules Demo

// Main geometry: intersection minus holes
difference() {
    intersection() {
        body();
        intersector();
    }
    holes();
}

// Primitives
module body() {
    color("Blue") sphere(10);
}

module intersector() {
    color("Red") cube(15, center=true);
}

module holeObject() {
    color("Lime") cylinder(h=20, r=5, center=true);
}

// Hole orientations
module holeA() rotate([0,90,0]) holeObject();
module holeB() rotate([90,0,0]) holeObject();
module holeC() holeObject();

module holes() {
    union() {
        holeA();
        holeB();
        holeC();
    }
}

sphere(5);

echo(version=version());
