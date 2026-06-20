# @taucad/viewer

Reusable Tau CAD viewer primitives for static and live gallery surfaces

`@taucad/viewer` is the package boundary for embeddable viewer-facing code that should be reusable outside Tau's full authoring app.

The first exported surface is static geometry loading:

```ts
import { loadStaticGeometry } from '@taucad/viewer';

const geometry = await loadStaticGeometry({
  kind: 'static',
  url: '/models/bracket.glb',
});
```

Use this package for reusable gallery/viewer primitives. Keep route-specific UI, project creation, auth, and editor state in the app that owns those workflows.
