// Configuration
$fn = 50;
stamp_knub = "stamp_template_knub.stl";

/*[Component Selection]*/
// Combo box to select which component to render
component_selection = "stamp"; // [stamp:Stamp, handle:Handle]

// Stamp style selection
svg_style = "negative"; // [positive, negative]

// Parameters
svg_file = "yaa.svg";
svg_stroke_width = 0.7;
knub_height = 10;
knub_radius = 10;
wrapper_rect = [30, 40];
rounded_radius = 5;
svg_adjust = [-0.7, 0];
svg_scale = 0.16;
stamp_ridge_height = 2.5;
cut_depth = 2.5; // Depth for negative cutting
reverse_svg = true;

// Pre-calculate common values
x = wrapper_rect[0]/2 - rounded_radius;
y = wrapper_rect[1]/2 - rounded_radius;

// Main components
if (component_selection == "stamp") {
    union() {
        // Stamp SVG based on style
        if (svg_style == "positive") {
            color("white", 0.8) 
                translate([0, 0, knub_height]) 
                    linear_extrude(stamp_ridge_height + 0.1) 
                        processed_svg();
        } else {
            difference() {
                // Create a rounded flat surface at knub height
                translate([0, 0, 10])
                    linear_extrude(cut_depth)
                        rounded_rectangle();
                
                // Cut out the SVG pattern
                translate([0, 0, 10 - 0.1])
                    linear_extrude(cut_depth + 0.2)
                        processed_svg();
            }
        }
        
        // Add the knub
        rotate(30) {
            color("red", 0.5) {
                import(stamp_knub, center=true);
            }
        }
        
        // Add the wrapper
        color("blue", 0.5) {
            linear_extrude(knub_height) {
                difference() {
                    rounded_rectangle();
                    circle(knub_radius - 0.1);
                }
            }
        }
    }
} else if (component_selection == "handle") {
    // Show only the handle template STL
    color("red", 0.5) {
        import("stamp_template_handle.stl", center=true);
    }
}

// Consolidated SVG processing function
module processed_svg() {
    translate([svg_adjust[0], svg_adjust[1], 0]) {
        offset(r = svg_stroke_width/2) {
            scale([svg_scale, svg_scale, 1]) { 
                if (reverse_svg) {
                    rotate(180) {
                        mirror([0,1,0]) {
                            import(svg_file, center=true);
                        }
                    }
                } else {
                    import(svg_file, center=true);
                }
            }
        }
    }
}

// Simplified rounded rectangle module
module rounded_rectangle() {
    hull() {
        translate([-x, y]) circle(rounded_radius);
        translate([ x, y]) circle(rounded_radius);
        translate([ x,-y]) circle(rounded_radius);
        translate([-x,-y]) circle(rounded_radius);
    }
}
