# Native eInk image processing plan

## Status

Implemented. The service ships deterministic grayscale and monochrome processing, Floyd–Steinberg and Atkinson dithering, inversion, and right-angle rotation. Custom palettes remain deferred.

## Goal

Produce panel-ready images with deterministic grayscale, palette reduction, dithering, inversion, and rotation while preserving exact configured output dimensions.

## Configuration

Add an `imageProcessing` task object with explicit defaults:

```json
{
  "mode": "color",
  "palette": [],
  "dither": "none",
  "threshold": 128,
  "invert": false,
  "rotation": 0
}
```

The shipped modes are `color`, `grayscale`, and `monochrome`; rotations are `0`, `90`, `180`, and `270`; and the deterministic dithering choices are `none`, `floyd-steinberg`, and `atkinson`. `palette` must currently remain empty. Custom palettes should be added only after exact color matching and output-format behavior are well tested.

## Implementation

1. Evaluate a maintained image library that supports pinned, reproducible Linux builds in the Playwright container. Prefer one bounded dependency over handwritten PNG/JPEG codecs.
2. Capture to a unique temporary source file as today.
3. Process into a second temporary output file, validate its format and exact dimensions, then atomically rename it over the last-good image.
4. For 90° and 270° rotation, define whether width and height describe final output. The recommended contract is that they always describe the delivered image; resize/crop before rotation accordingly.
5. Use fixed color-space conversion and deterministic dithering settings. Strip unnecessary metadata.
6. Preserve JPEG quality handling, while warning that monochrome eInk output is usually better delivered as PNG.
7. Surface a processing failure as a capture failure and retain the previous image.

## Verification

- Add small deterministic image fixtures with expected hashes or exact pixel assertions.
- Verify every mode, threshold boundary, dithering option, inversion, rotation, and PNG/JPEG combination.
- Assert final dimensions for portrait and landscape tasks.
- Test temporary-file cleanup and last-good retention after processing errors.
- Compare representative Home Assistant cards visually on at least one supported eInk device or emulator.
- Validate the Docker image on every supported architecture before release.

## Non-goals and safeguards

Do not add arbitrary image-processing scripts, shell commands, or public transformation parameters. Processing is configured per authenticated task and runs only after a successful capture. Avoid features that make output dimensions depend on page content.
