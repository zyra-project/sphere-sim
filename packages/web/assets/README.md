# packages/web/assets

## `blue-marble-4096.jpg`

A 4096 × 2048 equirectangular Earth map — NASA's Blue Marble — used as the
sphere's default content.

**Where it came from.** Supplied by the project owner in the handoff archive for
the reference implementation, where it is that page's default content. It is here
because it was given, not because it was found: this repository's standing
instruction is *do not scrape images, I will supply files*, and until this file
arrived the page shipped with no imagery at all and asked the reader to drop
their own in.

**What it is for.** A graticule on flat grey is the honest alignment pattern and
it is what the displacement gate measures, but it is also an abstraction. A
misalignment that doubles a coastline is the same misalignment, and it is the one
a person recognises. Both are one click apart on the Room tab, and the drop
target still takes any 2:1 image you like — a NOAA dataset, a test chart,
anything — read in the page and never uploaded anywhere.

**Provenance class.** `CFG` for the file, `ASSUME` for the claim that it is
representative of what a real SOS shows. No metric reads it: `test/model.test.ts`
pins that the supplied image cannot move a PARAMETERS.md §7 number, because the
geometry metrics sample the grid pattern regardless of what is on screen.
