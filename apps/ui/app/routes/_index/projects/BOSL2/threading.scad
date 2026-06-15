// Minimal thread approximations for bundled gallery models.
// These preserve dimensions for preview/export without generating helical thread detail.

CENTER = [0, 0, 0];

module screw_thread(d=10, l=10, pitch=1, internal=false, anchor=CENTER) {
    center = anchor == CENTER;
    translate(center ? [0, 0, 0] : [0, 0, l / 2])
        cylinder(d=d, h=l, center=true);
}

module threaded_rod(d=10, l=10, pitch=1, internal=false, anchor=CENTER) {
    screw_thread(d=d, l=l, pitch=pitch, internal=internal, anchor=anchor);
}
