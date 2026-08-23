# Validation — real photographs vs our renders

**Not part of the optimization loop. Not read by any critic.** Nothing in this
directory feeds a metric, a gate, or a score. Its only job is plausibility: if
our simulator's render looks nothing like a real sphere, the model is broken no
matter how good the numbers look.

## Provenance — read before adding anything

Images are **not scraped**. The project owner supplies files. NOAA imagery is
generally public domain, but photographs submitted to NOAA by individual SOS
sites may not be, so **treat provenance as unknown until the owner says
otherwise.**

Every image needs a row in `sources.json` before the validation page will render
it. The page shows the provenance field next to each photo, and images marked
`unknown` render with an explicit "provenance unverified — not for
redistribution" banner.

## How to add photographs

1. Drop image files into `validation/photos/`.
2. Add an entry to `validation/sources.json`:

```json
{
  "file": "sos-gsfc-2019.jpg",
  "provenance": "unknown",
  "credit": "",
  "site": "",
  "dataset": "",
  "notes": "supplied by owner, source not yet confirmed"
}
```

`provenance` is one of `public-domain`, `licensed`, `owner-supplied`, `unknown`.

3. If you know which SOS dataset was on the sphere, put its name in `dataset`
   and place a matching equirectangular source image in `validation/datasets/`.
   The page then renders our simulation of the same dataset beside the photo.
   Without a matching dataset the photo still appears, just without a pair.

4. Run `node packages/bench/src/validation.ts` to regenerate the page.

## What we look for in the photos

The second purpose is evidence about `ASSUME`-class parameters — the ones
PARAMETERS.md says nobody has measured. Specifically:

| Evidence | Parameter it bears on | Section |
| --- | --- | --- |
| Where the bottom mask boundary actually sits | `mask_lo`, `mask_hi`, and whether `bottommask 60,70` is latitude or colatitude | §4.4, AMENDMENTS A-02 |
| Visible seam structure — is it a bright band, a dark band, or a **coloured** one? | `γ_R,G,B` divergence, the rev 2 central claim | §3.2 |
| Overall ambient wash, contrast in dark content | `E_amb`, `E_amb_chroma` | §5 |
| Whether the polar unlit region reads as scalloped or circular | Confirms or refutes §4.3 against reality |§4.3 |
| Visible overlap multiplicity in bright flat content | §4.2's claim that N never exceeds 2 | §4.2 |

**Findings get logged as proposed amendments in `docs/AMENDMENTS.md`. Constants
are never silently changed.** A photograph is weak evidence — exposure, white
balance, JPEG processing, and the photographer's screen all sit between the
sphere and the pixel — so a finding here is a reason to put something on the
§8 measurement checklist, not a reason to edit a nominal.
