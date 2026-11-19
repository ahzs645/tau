# Parameter schema migration

The geometry functions and `defaultParams` retain their original values from fork commit `996774cc25a147c085fbdcc47a4a89cc0dfe701f`. The declaration changes adapt the existing parameter controls to the public runtime's native parameter contract.

The old lower-module schema used schema-valued Draft-7 `dependencies`, which the native converter explicitly rejects. A typed `oneOf` now selects the same three branches through the required `module` discriminator: `none`, `handle`, or `opener`. Each branch preserves the original fields, enum choices, ranges, labels and defaults. Additional properties remain admitted so inactive module settings survive switching.

Five old `multipleOf` constraints rejected their own authored defaults. Their increments are now precise enough to admit those values:

| Parameter | Unchanged default | Previous increment | Admitted increment |
| --- | ---: | ---: | ---: |
| `fins.rootOffsetDeg` | -7.36 | 0.1 | 0.01 |
| `fins.phaseDeg` | 1.67 | 0.1 | 0.01 |
| `fins.supportPhaseOffsetDeg` | -1.03 | 0.1 | 0.01 |
| `fins.innerWidth` | 0.86 | 0.05 | 0.01 |
| `fins.supportInnerWidth` | 0.855 | 0.05 | 0.005 |

All previously admitted increments are still admitted. No geometry dimension, enum choice, numeric minimum or maximum is changed by this schema correction.

The real runtime gate is `pnpm nx run gallery:verify-models --project=pet-bottle-opener --regressions --all-exports`. It renders the default and all seven shipped presets, verifies the authored enum schema remains present, measures the actual scene triangles, and checks GLB export bounds against the preview. The browser gate also checks conditional parameter controls through the public viewer.
