[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](license)
[![Discord](https://img.shields.io/badge/Discord-Join%20us-7289da?logo=discord&logoColor=white)](https://discord.gg/6pfSAN3t7A)
[![XO code style](https://shields.io/badge/code_style-5ed9c7?logo=xo&labelColor=gray&logoSize=auto)](https://github.com/xojs/xo)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org)

# Tau

The AI-native CAD platform — open-source, browser-based, and kernel-agnostic. Design anything from 3D prints, game assets, and more.

**[Try it now at tau.new](https://tau.new)**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tau-desktop-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/tau-desktop-light.jpg">
  <img alt="Tau Desktop View" src="docs/assets/tau-desktop-light.jpg">
</picture>

> 🚧 **Tau is currently under heavy development.** APIs and interfaces may change as we add new features and improvements.

## Features

- **Open Source** — MIT licensed
- **Browser-Based** — Run CAD on mobile or desktop, no **installation** required
- **Code-Based CAD** — Precise, version-controlled designs through code
- **AI-Powered** — Natural language interface for design creation and modification
- **Parametric Editor** — Adjustable parameters with real-time preview
- **Multi-Kernel** — Choose the right CAD engine for your project
- **Embeddable** — Components to bring CAD into any web application

## Use Cases

- **3D Printing** — Design and export to STL, 3MF, and slicer-compatible formats
- **Game Development** — Create 3D models for games and simulations
- **Industrial Design** — Create 3D models for industrial design and manufacturing
- **CAD Prototyping** — Parametric code with version control and instant iteration
- **Academic Research** — Kernel APIs for computational geometry and educational tools

## Supported Kernels

Tau's multi-kernel architecture lets you choose the best CAD engine for your needs.

### Mechanical

- [x] **[OpenSCAD](https://openscad.org/)** — Script-based CSG modeling, perfect for 3D printing
- [x] **[Replicad](https://replicad.xyz/)** — TypeScript CAD with OpenCascade for precise engineering
- [x] **[Zoo (KCL)](https://zoo.dev/)** — Cloud-native CAD with AI integration
- [x] **[JSCAD](https://openjscad.xyz/)** — JavaScript parametric modeling
- [ ] Fusion360
- [ ] Build123D
- [ ] TrCAD
- [ ] ManifoldCAD
- [ ] Curv
- [ ] ScriptCAD

### Electrical

- [ ] **[TSCircuit](https://tscircuit.com/)** — Open-source PCB design
- [ ] **[Atopile](https://atopile.io/)** — Hardware description language

### Firmware

- [ ] **[Arduino](https://www.arduino.cc/)** — Electronics platform

## Supported Simulators

Tau will integrate browser-compatible simulation environments for validating designs.

### Mechanical

- [ ] **[FEAScript](https://feascript.com/)** — JavaScript finite element analysis library

### Electrical

- [ ] **[ngspice](https://ngspice.sourceforge.io/)** — SPICE circuit simulator (WASM)
- [ ] **[CircuitJS](https://www.falstad.com/circuit/)** — JavaScript circuit simulator

### Firmware

- [ ] **[QEMU](https://www.qemu.org/)** — Machine emulator and virtualizer (WASM)
- [ ] **[Wokwi](https://wokwi.com/)** — Browser-based Arduino and ESP32 simulator

## File Converter

Convert between **41 input formats** and **11 output formats** including STL, STEP, GLTF, FBX, 3MF, OBJ, and more.

## Community

- **Discord** — [Join our community](https://discord.gg/6pfSAN3t7A)
- **Documentation** — [tau.new/docs](https://tau.new/docs)
- **GitHub Discussions** — Ask questions and share ideas

## Contributing

We welcome contributions! Please see our [Contributing Guide](contributing.md) for development setup and guidelines.

## Security

For security concerns, please review our [Security Policy](security.md).

## Code of Conduct

Please read our [Code of Conduct](code_of_conduct.md) before participating.

## Built With

Tau is built on a foundation of excellent open-source projects:

| Category             | Technologies                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| **State Management** | [XState V5](https://xstate.js.org/)                                                                        |
| **Code Editor**      | [Monaco Editor](https://microsoft.github.io/monaco-editor/)                                                |
| **3D Rendering**     | [Three.js](https://threejs.org/), [React Three Fiber](https://docs.pmnd.rs/react-three-fiber)              |
| **UI Framework**     | [React 19](https://react.dev/), [Radix UI](https://www.radix-ui.com/), [shadcn/ui](https://ui.shadcn.com/) |
| **File Tree**        | [Headless Tree](https://headless-tree.lukasbach.com/)                                                      |
| **AI Orchestration** | [LangChain](https://js.langchain.com/)                                                                     |
| **3D Processing**    | [glTF-Transform](https://gltf-transform.dev/), [Assimp](https://assimp.org/)                               |
| **CAD Kernels**      | [OpenCascade.js](https://ocjs.org/) (via Replicad)                                                         |
| **Documentation**    | [Fumadocs](https://fumadocs.dev/)                                                                          |
| **Database**         | [Drizzle ORM](https://orm.drizzle.team/)                                                                   |
| **Git Operations**   | [Isomorphic Git](https://isomorphic-git.org/)                                                              |

Special thanks to [OpenSCAD Playground](https://github.com/openscad/openscad-playground) for inspiring the browser-based code-CAD architecture.
## License

Tau is dual-licensed:

- **[MIT License](license)** — For all components except the OpenSCAD kernel
- **GPL-2.0-or-later** — When using the OpenSCAD kernel

If you use Tau **without** the OpenSCAD kernel (e.g., only Replicad, Zoo, or JSCAD), the entire codebase is available under the permissive MIT License. If you use Tau **with** the OpenSCAD kernel, the combined work is subject to [GPL-2.0-or-later](https://www.gnu.org/licenses/gpl-2.0.html) terms due to the `openscad-wasm-prebuilt` dependency.

Third-party license information is available in [license-deps](license-deps).
