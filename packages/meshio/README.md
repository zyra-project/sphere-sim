# packages/meshio

Reads a model file into the boundary object's `SurfaceMesh`. That is all it does.

## Why it is a package and not a function in `packages/sim`

`tools/boundary-lint.ts` R1: **`packages/sim` and `packages/solver` may import
`packages/calibration` and nothing else.** A loader placed anywhere either model
could reach would be an R1 violation, and the lint's own message says why in the
general case — "a shared helper package is how the boundary erodes: today it
holds a PRNG, next month it holds a distortion model, and every recovery score
becomes circular."

A GLB reader is the most plausible-looking thing anyone would ever want to share
across that boundary. It is pure IO, it holds no geometry, and duplicating it
feels like waste. That is exactly the argument that would be made for sharing a
PRNG. So the answer is written down in three places: here, in
`packages/calibration/src/mesh.ts`, and as a test in `test/boundary.test.ts` that
names this package so whoever is about to make the argument can find the answer.

The arrangement:

```
        packages/meshio          bytes -> SurfaceMesh (arrays)
               |
               v
      packages/calibration       the boundary object. No math (R2)
          /          \
         v            v
   packages/sim   packages/solver
   own BVH        own BVH
   own ray-triangle   own ray-triangle
```

`packages/web` and `packages/bench` — the packages that already hold both models —
read a file here and hand the arrays to each side. Neither model can reach the
reader, and neither can reach the other's traversal.

## What it reads

Binary glTF 2.0 (`.glb`): a 12-byte header, a JSON chunk, an optional BIN chunk.
GLB before `.gltf` because it is one file rather than a JSON document plus a
`.bin` plus textures, and a browser file drop hands over one file.

Handled, because a real exporter produces them:

- the node hierarchy, with transforms accumulated down the tree
- TRS **and** matrix node transforms, and the same mesh instanced under several
  nodes
- interleaved buffer views (`byteStride`)
- normalized integer attributes
- non-uniform scale on normals, through the inverse transpose
- meshes with no UV set, and meshes with no normals

Refused, and **named in the report** rather than dropped in silence:

- non-triangle primitives (lines, points, strips, fans)
- Draco compression
- external buffers referenced by URI
- sparse accessors

A model that arrives with half its geometry missing has to say so. The
alternative is somebody studying a coverage map of a shape that is not the one
they loaded.

## The up axis

glTF is Y-up (spec §3.4). This repository is Z-up — `conventions.ts` §W puts
world +Z toward the ceiling, and the rig, the floor plane and the polar mask are
all written against that. The reader rotates a quarter turn about +X so the
file's +Y becomes world +Z.

A loader that skipped this would lay every model on its side, which reads as "the
exporter is odd" rather than as a bug in the reader. `GlbOptions.upAxis` turns it
off for the CAD and GIS pipelines that export Z-up in violation of the spec.

The conversion is a rotation, so it cannot mirror and the winding survives. That
matters: a mirroring conversion would turn a closed model inside out, and every
surface would face away from its projector — visible as a sphere lit from within.

## Tests

`test/glb.test.ts` builds its files byte by byte from the specification rather
than checking in a fixture exported by a modelling tool. A fixture proves the
reader agrees with whatever that one exporter wrote; the cases that break a
loader are the ones a single exporter never produces.

The load-bearing check runs bytes all the way to geometry: a tessellated sphere
written out as a GLB, read back, built into `packages/sim`'s `MeshSurface`, and
intersected against `raySphereIntersect`. If the reader mangles a stride, an
index offset or the up axis, the hit lands somewhere the analytic sphere is not.
