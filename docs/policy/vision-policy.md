# Vision Policy

Tau's vision is to connect the five pillars of hardware engineering — systems design, analysis, CAD, software/firmware, and simulation — through code and AI agents.

## The Problem

Hardware engineering today is fragmented across disconnected tools: CAD packages, spreadsheets, firmware IDEs, simulation suites, and requirements trackers. Each tool is a silo. Each handoff loses fidelity. AI can automate 90% of the execution within each silo, but the silos themselves remain.

The problem isn't automating individual tasks — it's connecting them. A geometry change should propagate through stress analysis, firmware constraints, and simulation automatically. That connection must be programmable, versionable, and agent-accessible. The medium that enables all three is code.

## The Five Pillars

```
Systems/Requirements ──┐
Analysis (math)      ──┤
CAD (3D geometry)    ──┼── Code ── AI Agents ── Automated Hardware Development
Software/Firmware    ──┤
Simulation           ──┘
```

## Progression

### Phase 1: Geometry (MCAD) — Current

Solve code-first mechanical CAD. Tau today is an AI-native, multi-kernel CAD platform:

- **Multi-kernel runtime** (`@taucad/kernels`) — Replicad, JSCAD, Manifold, OpenSCAD, KCL, any CAD kernel behind a unified `defineKernel()` API. BRep and mesh geometry, parametric models as TypeScript/OpenSCAD/KCL functions.
- **AI agent** — LangGraph agent with file editing, kernel execution, TDD via `test.json`, screenshot verification. The agent writes geometry code, runs it, measures the result, iterates.
- **Converter** (`@taucad/converter`) — 41 input formats, 11 output formats. STEP, STL, glTF, USDZ, IFC, and more. Convert any file format to another.
- **Browser-native** — No install. Web Workers for computation, WebGL for rendering. Embeddable components for third-party apps.
- **Open source** — Published `@taucad/*` packages on npm. MIT licensed.
- **Files are the interface** — Everything is a file. Geometry, tests, metadata. Agent skills, subagents, scripts. A single data plane makes computational engineering precise, reproducible, with provenance by design. No vendor lock-in.

This phase proves the thesis: geometry defined as code can be created, modified, tested, and iterated on by AI agents with human oversight.

### Phase 2: Analysis & Simulation

Add engineering analysis:

- **FEA/CFD kernels** — FEAScript and future solvers. Stress, thermal, and fluid analysis on geometry produced by MCAD kernels.
- **Mathematical analysis** — Automated engineering calculations that feed requirements into geometry parameters.
- **Test-driven engineering** — Extend the `test.json` pattern to physical requirements: max stress, thermal limits, weight budgets. AI agents iterate until specs are met.

### Phase 3: Systems Integration

Wire it all together:

- **Multi-agent orchestration** — Domain-specific AI agents (mechanical, electrical, firmware, simulation) coordinating through a systems agent that maintains cross-discipline constraints.
- **Requirements traceability** — From system requirements down to geometry parameters, pin assignments, and firmware constants — all in code, all version-controlled.
- **Automated iteration** — Change a requirement, and agents propagate the impact through every discipline, flagging conflicts and proposing solutions.

### Phase 4: Electrical (ECAD)

Extend the kernel architecture to circuit design:

- **ECAD kernels** — TSCircuit, Atopile. Schematics and PCB layout as code, running in the same multi-kernel runtime.
- **Electrical simulation kernels** — ngspice, CircuitJS. Validate circuits against specs without leaving the platform.
- **Cross-discipline linking** — Mechanical enclosures constrained by PCB dimensions. Mounting holes, connector cutouts, and thermal considerations flow between MCAD and ECAD models.

### Phase 5: Firmware

Bring embedded software into the same code-first workflow:

- **Firmware kernels** — Arduino, MicroPython. Write, compile, and simulate firmware alongside the hardware it runs on.
- **Firmware simulation** — QEMU, Wokwi. Virtual hardware-in-the-loop testing before physical prototyping.
- **Hardware-firmware co-design** — Pin assignments, peripheral constraints, and communication protocols linked between ECAD schematics and firmware code.

### Phase 6: Automated Robotic Systems

The endgame. When all five pillars are connected through code, the platform becomes a robotic systems factory:

- **End-to-end generation** — Describe a robot's purpose. Agents generate the mechanical design, PCB layout, firmware, and control software as a single coordinated codebase. Every artifact traces back to requirements.
- **Simulation-validated designs** — Full-system simulation (structural, electrical, firmware-in-the-loop) runs before any physical part is manufactured. Agents iterate until the simulated system meets spec.
- **Fleet management** — Robots in the field are parameterized variants of the same codebase. Update a requirement, re-run the pipeline, push firmware OTA, and queue revised parts for manufacturing. Fleet-wide changes propagate from code, not spreadsheets.
- **Continuous physical iteration** — Field telemetry feeds back into the system model. Agents identify failure modes, propose design changes, simulate fixes, and produce updated build artifacts — closing the loop between deployed hardware and the engineering workspace.

## Design Principles

- **Code is the interface.** Every engineering artifact — geometry, circuits, firmware, test specs, requirements — is represented as code. Code is versionable, diffable, reviewable, and agent-accessible.
- **Everything is pluggable.** The `defineKernel()` pattern scales to any engineering domain. New solvers, languages, and tools plug into the same runtime, transport, and middleware stack.
- **AI agents are collaborators.** Agents don't replace engineers — they handle the thousands of micro-problems that make up a system design, while humans make the architectural decisions.
- **Open by default.** Published packages, open protocols, embeddable components. Hardware tooling has been locked in proprietary silos for decades.
