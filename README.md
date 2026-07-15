# Tessamorigami

Tessamorigami is a set of five browser studies for probing how geometry, dimensional projection, and physical behavior can become sound. Study 01 remains the original continuous prototype; Studies 02–05 isolate one question each and make its controls explicit.

## Run

```bash
cd ~/tessamorigami
npm run dev
```

Open <http://localhost:4174>. Sound begins only after a user gesture.

## Studies

1. **Seed / surface / shadow** (`index.html`) — the original tile-to-field-to-fold-to-4D sequence, unchanged apart from navigation to the new studies.
2. **Lattice line** (`02-lattice.html`) — controllable straight or curved tile boundaries crossed by one line; every visible dot is a deduplicated lattice intersection.
3. **4D section** (`03-hyperplane.html`) — an actual two-dimensional affine plane clipped by a four-dimensional hypercube; every section corner sounds at once.
4. **Gravity field** (`04-gravity.html`) — a stable spring lattice with gravity, wind, tension, pointer throws, and floor impacts; simulation forces drive the sound.
5. **Field loom** (`05-stretch.html`) — a deformable 3D field cut by a moving plane, with switchable depth, position, and strain mappings. Turning the view changes the depth mapping and stereo projection.

## Study 01 controls

- **Form** selects triangle, square, pentagon, or hexagon isohedral families.
- **Crease** alters both the prototile parameters and its matching curved edge shapes.
- **Repeat** grows real tactile-js tile instances outward from the seed.
- **Fold** raises the sheet into a draggable projected 3D surface.
- **Beyond** extrudes the seed through W and reveals an animated 3D slice of its 4D prism.
- **Pulse** sets perimeter playback speed.

## Sources

- Sound behavior is adapted from the local `~/fun/tesselateher` studies.
- Isohedral tilings use vendored `tactile-js`, copyright Craig S. Kaplan, under the included BSD 3-Clause license.
- Plane rotations, projection, and slicing follow the concepts in Bartosz Ciechanowski’s *Tesseract* article.
