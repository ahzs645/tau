import type { FileExtension } from '@taucad/types';
import { legacyPlaygroundExamples } from '#routes/playground/legacy-playground-examples.js';
import { projectExamples } from '#routes/playground/projects.js';

export type PlaygroundPreset = {
  readonly name: string;
  readonly parameters: Record<string, unknown>;
};

export type PlaygroundStaticPreview = {
  readonly glb: string;
};

export type PlaygroundExample = {
  readonly id: string;
  readonly name: string;
  readonly kernel: 'OpenSCAD' | 'Replicad' | 'OpenCascade' | 'Static';
  readonly mode?: 'editable' | 'static';
  readonly mainFile: string;
  readonly language: string;
  readonly description: string;
  readonly exportFormats: readonly FileExtension[];
  readonly initialParameters?: Record<string, unknown>;
  readonly presets?: readonly PlaygroundPreset[];
  readonly staticPreview?: PlaygroundStaticPreview;
  readonly code: string;
  readonly sourceFiles?: Record<string, string>;
};

const curatedPlaygroundExamples: readonly PlaygroundExample[] = [
  {
    id: 'openscad-bracket',
    name: 'OpenSCAD bracket',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Boolean plate with posts and through holes.',
    exportFormats: ['glb'],
    presets: [
      {
        name: 'Wide',
        parameters: { plate: [90, 42, 6], post_radius: 9, hole_radius: 3.4 },
      },
      {
        name: 'Compact',
        parameters: { plate: [54, 32, 5], post_radius: 6.5, hole_radius: 2.8 },
      },
    ],
    code: `$fn = 64;

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
}`,
  },
  {
    id: 'gel-comb-scad',
    name: 'Gel comb SCAD',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Ported lab comb from the old playground gallery.',
    exportFormats: ['glb'],
    presets: [
      {
        name: 'Dense',
        parameters: {
          tooth_count: 36,
          tooth_width: 2.4,
          tooth_gap: 1.1,
          show_side_hooks: true,
        },
      },
      {
        name: 'Wide teeth',
        parameters: {
          tooth_count: 20,
          tooth_width: 4,
          tooth_gap: 2,
          show_side_hooks: false,
        },
      },
    ],
    code: `$fn = 48;

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
}`,
  },
  {
    id: 'replicad-tray',
    name: 'Replicad tray',
    kernel: 'Replicad',
    mainFile: 'main.ts',
    language: 'typescript',
    description: 'Editable rounded tray using Tau’s Replicad kernel.',
    exportFormats: ['step', 'stl', 'glb'],
    presets: [
      {
        name: 'Desk tray',
        parameters: {
          width: 140,
          depth: 85,
          height: 16,
          wall: 3,
          radius: 8,
          style: 'open',
        },
      },
      {
        name: 'Solid block',
        parameters: {
          width: 70,
          depth: 45,
          height: 18,
          wall: 3,
          radius: 5,
          style: 'solid',
        },
      },
    ],
    code: `import { drawRoundedRectangle } from 'replicad';
import type { Shape3D } from 'replicad';

export const defaultParams = {
  width: 90,
  depth: 55,
  height: 18,
  wall: 3,
  radius: 6,
  style: 'open',
};

export const jsonSchema = {
  type: 'object',
  title: 'Tray Parameters',
  required: ['width', 'depth', 'height', 'wall', 'radius', 'style'],
  properties: {
    width: { type: 'number', title: 'Width', default: 90, minimum: 30, maximum: 180 },
    depth: { type: 'number', title: 'Depth', default: 55, minimum: 25, maximum: 140 },
    height: { type: 'number', title: 'Height', default: 18, minimum: 4, maximum: 60 },
    wall: { type: 'number', title: 'Wall', default: 3, minimum: 1, maximum: 10 },
    radius: { type: 'number', title: 'Radius', default: 6, minimum: 1, maximum: 20 },
    style: {
      type: 'string',
      title: 'Style',
      default: 'open',
      enum: ['open', 'shallow', 'solid'],
    },
  },
};

export default function main(params = {}): Shape3D {
  const p = { ...defaultParams, ...params };
  const outer = drawRoundedRectangle(p.width, p.depth, p.radius)
    .sketchOnPlane()
    .extrude(p.height);

  if (p.style === 'solid') {
    return outer.fillet(0.8);
  }

  const cavityHeight = p.style === 'shallow' ? p.height * 0.55 : p.height;
  const inner = drawRoundedRectangle(
    p.width - p.wall * 2,
    p.depth - p.wall * 2,
    Math.max(1, p.radius - p.wall),
  )
    .sketchOnPlane()
    .extrude(cavityHeight)
    .translate([0, 0, p.wall]);

  return outer.cut(inner).fillet(0.8);
}`,
  },
  {
    id: 'networking-rack-scad',
    name: 'Networking rack',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Ported network equipment rack from the old gallery.',
    exportFormats: ['glb'],
    presets: [
      {
        name: 'Tall rack',
        parameters: { rack_height: 140, rack_depth: 92, vent_spacing: 7 },
      },
      {
        name: 'Mini rack',
        parameters: {
          rack_width: 90,
          rack_depth: 65,
          rack_height: 72,
          vent_spacing: 10,
        },
      },
    ],
    code: `$fn = 32;

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

networking_rack();`,
  },
  {
    id: 'opencascade-box',
    name: 'OpenCascade direct',
    kernel: 'OpenCascade',
    mainFile: 'main.ts',
    language: 'typescript',
    description: 'Raw opencascade.js shape returned through Tau.',
    exportFormats: ['step', 'stl', 'glb'],
    presets: [
      {
        name: 'Sharp',
        parameters: {
          width: 52,
          depth: 34,
          height: 20,
          fillet: 0,
          profile: 'sharp',
        },
      },
      {
        name: 'Tall soft',
        parameters: {
          width: 42,
          depth: 30,
          height: 42,
          fillet: 4,
          profile: 'soft',
        },
      },
    ],
    code: `import {
  BRepPrimAPI_MakeBox,
  BRepFilletAPI_MakeFillet,
  ChFi3d_FilletShape,
  TopAbs_ShapeEnum,
  TopExp_Explorer,
  TopoDS,
} from 'opencascade.js';

export const defaultParams = {
  width: 52,
  depth: 34,
  height: 20,
  fillet: 3,
  profile: 'soft',
};

export const jsonSchema = {
  type: 'object',
  title: 'OpenCascade Box Parameters',
  required: ['width', 'depth', 'height', 'fillet', 'profile'],
  properties: {
    width: { type: 'number', title: 'Width', default: 52, minimum: 10, maximum: 120 },
    depth: { type: 'number', title: 'Depth', default: 34, minimum: 10, maximum: 120 },
    height: { type: 'number', title: 'Height', default: 20, minimum: 5, maximum: 100 },
    fillet: { type: 'number', title: 'Fillet', default: 3, minimum: 0, maximum: 12 },
    profile: {
      type: 'string',
      title: 'Profile',
      default: 'soft',
      enum: ['soft', 'sharp'],
    },
  },
};

export default function main(params = {}) {
  const p = { ...defaultParams, ...params };
  const box = new BRepPrimAPI_MakeBox(p.width, p.depth, p.height).Shape();
  if (p.profile === 'sharp' || p.fillet <= 0) {
    return box;
  }

  const fillet = new BRepFilletAPI_MakeFillet(box, ChFi3d_FilletShape.ChFi3d_Rational);
  const explorer = new TopExp_Explorer(box, TopAbs_ShapeEnum.TopAbs_EDGE, TopAbs_ShapeEnum.TopAbs_SHAPE);

  if (explorer.More()) {
    fillet.Add(p.fillet, TopoDS.Edge(explorer.Current()));
  }

  explorer.delete();
  const result = fillet.Shape();
  fillet.delete();
  return result;
}`,
  },
] as const;

export const playgroundExamples: readonly PlaygroundExample[] = [
  ...curatedPlaygroundExamples,
  ...projectExamples,
  ...legacyPlaygroundExamples,
] as const;
