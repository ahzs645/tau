import type { PlaygroundExample } from '#routes/_index/playground-examples.js';
import old3dRackScadMainScad from '#routes/_index/imported-openscad-examples/old-3d-rack-scad/main.scad?raw';
import oldSaboteurCardHolderMainScad from '#routes/_index/imported-openscad-examples/old-saboteur-card-holder/main.scad?raw';
import oldTrayScadMainScad from '#routes/_index/imported-openscad-examples/old-tray-scad/main.scad?raw';
import oldKeyguardWithRaisedTabsMainScad from '#routes/_index/imported-openscad-examples/old-keyguard-with-raised-tabs/main.scad?raw';
import oldKeyguardWithRaisedTabsopenings_and_additions_txt from '#routes/_index/imported-openscad-examples/old-keyguard-with-raised-tabs/openings_and_additions.txt?raw';
import oldPeriodicTableMainScad from '#routes/_index/imported-openscad-examples/old-periodic-table/main.scad?raw';
import oldNetworkingMainScad from '#routes/_index/imported-openscad-examples/old-networking/main.scad?raw';
import oldParametricGelCombMainScad from '#routes/_index/imported-openscad-examples/old-parametric-gel-comb/main.scad?raw';
import oldPendantLampMainScad from '#routes/_index/imported-openscad-examples/old-pendant-lamp/Main.scad?raw';
import oldPreChamberNozzleInsertMainScad from '#routes/_index/imported-openscad-examples/old-pre-chamber-nozzle-insert/prechamber_nozzle_insert_BOSL2_threads.scad?raw';
import oldStampMainScad from '#routes/_index/imported-openscad-examples/old-stamp/Main.scad?raw';
import oldStampyaa_svg from '#routes/_index/imported-openscad-examples/old-stamp/yaa.svg?raw';
import oldVaneTrapMainScad from '#routes/_index/imported-openscad-examples/old-vane-trap/main.scad?raw';
import oldWhamMainScad from '#routes/_index/imported-openscad-examples/old-wham/main.scad?raw';

export const importedOpenScadExamples: readonly PlaygroundExample[] = [
  {
    id: 'old-3d-rack-scad',
    name: '3D Rack System (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Customizable modular rack system for organizing components and tools',
    exportFormats: ['glb'],
    code: old3dRackScadMainScad,
    sourceFiles: {
      'main.scad': old3dRackScadMainScad,
    },
  },
  {
    id: 'old-saboteur-card-holder',
    name: 'Card Holder Grid (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Organizational grid system for holding and displaying cards, perfect for board games',
    exportFormats: ['glb'],
    code: oldSaboteurCardHolderMainScad,
    sourceFiles: {
      'main.scad': oldSaboteurCardHolderMainScad,
    },
  },
  {
    id: 'old-tray-scad',
    name: 'Custom Tray System (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Customizable tray system for organizing tools and small items',
    exportFormats: ['glb'],
    code: oldTrayScadMainScad,
    sourceFiles: {
      'main.scad': oldTrayScadMainScad,
    },
  },
  {
    id: 'old-keyguard-with-raised-tabs',
    name: 'Customizable Keyguard (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: '3D printable keyguard for tablets and AAC devices with customizable raised tabs',
    exportFormats: ['glb'],
    code: oldKeyguardWithRaisedTabsMainScad,
    sourceFiles: {
      'main.scad': oldKeyguardWithRaisedTabsMainScad,
      'openings_and_additions.txt': oldKeyguardWithRaisedTabsopenings_and_additions_txt,
    },
  },
  {
    id: 'old-periodic-table',
    name: 'Interlocking Boxes System (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Modular interlocking box system perfect for organizing small parts and components',
    exportFormats: ['glb'],
    code: oldPeriodicTableMainScad,
    sourceFiles: {
      'main.scad': oldPeriodicTableMainScad,
    },
  },
  {
    id: 'old-networking',
    name: 'Network Equipment Rack (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Custom rack system for network equipment including POE switches and patch panels',
    exportFormats: ['glb'],
    code: oldNetworkingMainScad,
    sourceFiles: {
      'main.scad': oldNetworkingMainScad,
    },
  },
  {
    id: 'old-parametric-gel-comb',
    name: 'Parametric Gel Comb (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description:
      'Customizable gel comb with adjustable tooth count, tooth and bar thickness, ridges, slots, and side hooks',
    exportFormats: ['glb'],
    code: oldParametricGelCombMainScad,
    sourceFiles: {
      'main.scad': oldParametricGelCombMainScad,
    },
  },
  {
    id: 'old-pendant-lamp',
    name: 'Pleated Pendant Lamp (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'Main.scad',
    language: 'scad',
    description: 'Elegant pleated pendant lamp shade with customizable dimensions and pleating patterns',
    exportFormats: ['glb'],
    code: oldPendantLampMainScad,
    sourceFiles: {
      'Main.scad': oldPendantLampMainScad,
    },
  },
  {
    id: 'old-pre-chamber-nozzle-insert',
    name: 'Pre-Chamber Nozzle Insert (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'prechamber_nozzle_insert_BOSL2_threads.scad',
    language: 'scad',
    description:
      'Custom M14x1.25-to-M10x1.0 spark-plug pre-chamber / jet-ignition nozzle insert. Reverse-engineered starter CAD with BOSL2 helical threads, selectable original/corrected hex and collar dimensions, conical nozzle tip, 2.5 mm axial orifice, and angled 2.5/1.0 mm side jet holes. SCAD source included alongside the pre-rendered metal GLB.',
    exportFormats: ['glb'],
    code: oldPreChamberNozzleInsertMainScad,
    sourceFiles: {
      'prechamber_nozzle_insert_BOSL2_threads.scad': oldPreChamberNozzleInsertMainScad,
    },
  },
  {
    id: 'old-stamp',
    name: 'Stamp (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'Main.scad',
    language: 'scad',
    description: 'SVG-driven stamp generator using uploaded artwork',
    exportFormats: ['glb'],
    code: oldStampMainScad,
    sourceFiles: {
      'Main.scad': oldStampMainScad,
      'yaa.svg': oldStampyaa_svg,
    },
  },
  {
    id: 'old-vane-trap',
    name: 'Vane Trap Device (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Custom vane trap mechanism with adjustable parameters',
    exportFormats: ['glb'],
    code: oldVaneTrapMainScad,
    sourceFiles: {
      'main.scad': oldVaneTrapMainScad,
    },
  },
  {
    id: 'old-wham',
    name: 'Wham Project (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Experimental design project with customizable features',
    exportFormats: ['glb'],
    code: oldWhamMainScad,
    sourceFiles: {
      'main.scad': oldWhamMainScad,
    },
  },
];
