import type { PlaygroundExample } from '#routes/_index/playground-examples.js';
import rackScadMainScad from '#routes/_index/projects/3d-rack-scad/main.scad?raw';
import saboteurCardHolderMainScad from '#routes/_index/projects/saboteur-card-holder/main.scad?raw';
import trayScadMainScad from '#routes/_index/projects/tray-scad/main.scad?raw';
import keyguardWithRaisedTabsMainScad from '#routes/_index/projects/keyguard-with-raised-tabs/main.scad?raw';
import keyguardWithRaisedTabsOpeningsAndAdditions from '#routes/_index/projects/keyguard-with-raised-tabs/openings_and_additions.txt?raw';
import periodicTableMainScad from '#routes/_index/projects/periodic-table/main.scad?raw';
import networkingMainScad from '#routes/_index/projects/networking/main.scad?raw';
import parametricGelCombMainScad from '#routes/_index/projects/parametric-gel-comb/main.scad?raw';
import pendantLampMainScad from '#routes/_index/projects/pendant-lamp/Main.scad?raw';
import preChamberNozzleInsertMainScad from '#routes/_index/projects/pre-chamber-nozzle-insert/prechamber_nozzle_insert_BOSL2_threads.scad?raw';
import stampMainScad from '#routes/_index/projects/stamp/Main.scad?raw';
import stampYaaSvg from '#routes/_index/projects/stamp/yaa.svg?raw';
import vaneTrapMainScad from '#routes/_index/projects/vane-trap/main.scad?raw';
import whamMainScad from '#routes/_index/projects/wham/main.scad?raw';

const bosl2SourceFiles = import.meta.glob('./projects/BOSL2/**/*.scad', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const bosl2Files = Object.fromEntries(
  Object.entries(bosl2SourceFiles)
    .filter(([path]) => !path.endsWith('/joiners.scad'))
    .map(([path, content]) => [path.replace('./projects/', ''), content]),
);

function withBosl2(files: Record<string, string>): Record<string, string> {
  return {
    ...bosl2Files,
    ...files,
  };
}

export const projectExamples: readonly PlaygroundExample[] = [
  {
    id: '3d-rack-scad',
    name: '3D Rack System (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Customizable modular rack system for organizing components and tools',
    exportFormats: ['glb'],
    code: rackScadMainScad,
    sourceFiles: withBosl2({
      'main.scad': rackScadMainScad,
    }),
  },
  {
    id: 'saboteur-card-holder',
    name: 'Card Holder Grid (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Organizational grid system for holding and displaying cards, perfect for board games',
    exportFormats: ['glb'],
    code: saboteurCardHolderMainScad,
    sourceFiles: {
      'main.scad': saboteurCardHolderMainScad,
    },
  },
  {
    id: 'tray-scad',
    name: 'Custom Tray System (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Customizable tray system for organizing tools and small items',
    exportFormats: ['glb'],
    code: trayScadMainScad,
    sourceFiles: {
      'main.scad': trayScadMainScad,
    },
  },
  {
    id: 'keyguard-with-raised-tabs',
    name: 'Customizable Keyguard (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: '3D printable keyguard for tablets and AAC devices with customizable raised tabs',
    exportFormats: ['glb'],
    code: keyguardWithRaisedTabsMainScad,
    sourceFiles: {
      'main.scad': keyguardWithRaisedTabsMainScad,
      'openings_and_additions.txt': keyguardWithRaisedTabsOpeningsAndAdditions,
    },
  },
  {
    id: 'periodic-table',
    name: 'Interlocking Boxes System (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Modular interlocking box system perfect for organizing small parts and components',
    exportFormats: ['glb'],
    code: periodicTableMainScad,
    sourceFiles: {
      'main.scad': periodicTableMainScad,
    },
  },
  {
    id: 'networking',
    name: 'Network Equipment Rack (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Custom rack system for network equipment including POE switches and patch panels',
    exportFormats: ['glb'],
    code: networkingMainScad,
    sourceFiles: {
      'main.scad': networkingMainScad,
    },
  },
  {
    id: 'parametric-gel-comb',
    name: 'Parametric Gel Comb (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description:
      'Customizable gel comb with adjustable tooth count, tooth and bar thickness, ridges, slots, and side hooks',
    exportFormats: ['glb'],
    code: parametricGelCombMainScad,
    sourceFiles: {
      'main.scad': parametricGelCombMainScad,
    },
  },
  {
    id: 'pendant-lamp',
    name: 'Pleated Pendant Lamp (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'Main.scad',
    language: 'scad',
    description: 'Elegant pleated pendant lamp shade with customizable dimensions and pleating patterns',
    exportFormats: ['glb'],
    code: pendantLampMainScad,
    sourceFiles: withBosl2({
      'Main.scad': pendantLampMainScad,
    }),
  },
  {
    id: 'pre-chamber-nozzle-insert',
    name: 'Pre-Chamber Nozzle Insert (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'prechamber_nozzle_insert_BOSL2_threads.scad',
    language: 'scad',
    description:
      'Custom M14x1.25-to-M10x1.0 spark-plug pre-chamber / jet-ignition nozzle insert. Reverse-engineered starter CAD with BOSL2 helical threads, selectable original/corrected hex and collar dimensions, conical nozzle tip, 2.5 mm axial orifice, and angled 2.5/1.0 mm side jet holes. SCAD source included alongside the pre-rendered metal GLB.',
    exportFormats: ['glb'],
    code: preChamberNozzleInsertMainScad,
    sourceFiles: withBosl2({
      'prechamber_nozzle_insert_BOSL2_threads.scad': preChamberNozzleInsertMainScad,
    }),
  },
  {
    id: 'stamp',
    name: 'Stamp (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'Main.scad',
    language: 'scad',
    description: 'SVG-driven stamp generator using uploaded artwork',
    exportFormats: ['glb'],
    code: stampMainScad,
    sourceFiles: {
      'Main.scad': stampMainScad,
      'yaa.svg': stampYaaSvg,
    },
  },
  {
    id: 'vane-trap',
    name: 'Vane Trap Device (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Custom vane trap mechanism with adjustable parameters',
    exportFormats: ['glb'],
    code: vaneTrapMainScad,
    sourceFiles: withBosl2({
      'main.scad': vaneTrapMainScad,
    }),
  },
  {
    id: 'wham',
    name: 'Wham Project (Original)',
    kernel: 'OpenSCAD',
    mainFile: 'main.scad',
    language: 'scad',
    description: 'Experimental design project with customizable features',
    exportFormats: ['glb'],
    code: whamMainScad,
    sourceFiles: {
      'main.scad': whamMainScad,
    },
  },
];
