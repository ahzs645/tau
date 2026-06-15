// Minimal dovetail approximation for bundled gallery models.

module dovetail(type="male", slide=10, width=10, height=4, back_width=12, spin=0) {
    profile = type == "female"
        ? [[-back_width / 2, -height / 2], [back_width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]]
        : [[-width / 2, -height / 2], [width / 2, -height / 2], [back_width / 2, height / 2], [-back_width / 2, height / 2]];

    rotate([0, 0, spin])
        linear_extrude(height=slide, center=true)
            polygon(profile);
}

