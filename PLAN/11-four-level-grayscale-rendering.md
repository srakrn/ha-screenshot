# Four-level grayscale rendering plan

## Status

Implemented. The service ships configurable evenly spaced grayscale levels, deterministic reduced-grayscale dithering, indexed two-bit four-level PNG output, and grayscale browser text antialiasing. Custom nonuniform palettes remain deferred.

## Goal

Produce deterministic output for eInk panels that support four grayscale levels (2 bits per pixel), while preserving browser-rendered grayscale antialiasing and allowing quantization and dithering to be selected independently.

The standard four-level palette is `0`, `85`, `170`, and `255`. PNG is the preferred transport because it can preserve these exact tones without lossy compression.

## Configuration

Add `levels` to each task's `imageProcessing` object:

```json
{
  "mode": "grayscale",
  "levels": 4,
  "palette": [],
  "dither": "atkinson",
  "threshold": 128,
  "invert": false,
  "rotation": 0
}
```

`levels` is an integer from `2` through `256` and defaults to `256`, preserving current grayscale behavior. It applies only to grayscale mode. Four levels represent 2-bit grayscale; monochrome remains the existing two-tone mode with its configurable threshold.

Allow `none`, `floyd-steinberg`, and `atkinson` dithering for quantized grayscale as well as monochrome. Reject non-`none` dithering for color mode and for 256-level grayscale, where there is no palette-reduction error to diffuse. Keep `palette` reserved until calibrated, nonuniform panel palettes have a defined contract.

## Browser rendering

Launch Chromium with `--disable-lcd-text` so text uses grayscale coverage rather than RGB subpixel antialiasing. Retain antialiasing itself and keep `deviceScaleFactor` at `1`, ensuring one browser pixel maps to one output pixel before palette reduction.

Treat this as a global deterministic-rendering choice rather than a task setting. Add a capture test that records the launch options and verifies the flag is supplied.

## Image processing

1. Convert the captured RGB pixels to luminance using the existing fixed coefficients.
2. Generate an evenly spaced palette from `levels`. For four levels, this is exactly `0`, `85`, `170`, and `255`.
3. Quantize each pixel to its nearest permitted tone. Define midpoint ties consistently so output remains deterministic.
4. With `dither: "none"`, write the selected tone directly.
5. With Floyd–Steinberg or Atkinson dithering, distribute `originalTone - selectedTone` using the existing algorithm's weights before processing subsequent pixels.
6. Apply inversion after reduction and rotation last, preserving current behavior.

Generalize the existing monochrome error-diffusion helper rather than adding a second processing path. Keep monochrome threshold semantics unchanged so existing task output does not regress.

## Output encoding

For a four-level PNG, encode an indexed palette containing at most four entries and disable encoder-level dithering because pixel dithering has already been applied deterministically. Verify the written image reports two bits per sample and decodes only to the four configured tones.

Continue accepting JPEG for compatibility, but document that JPEG compression can introduce values outside the four-tone palette. Recommend PNG whenever exact eInk levels matter. This feature produces a standard image response; raw display-controller byte packing and device-specific waveform commands remain out of scope.

## Admin UI and documentation

Add a **Gray levels** input to the task editor, defaulting to `256`, with helper text stating that four levels equal 2-bit grayscale. Enable it only in grayscale mode.

Enable the dithering selector for monochrome and for grayscale with fewer than 256 levels. Keep the threshold input exclusive to monochrome. Preserve entered values when switching modes so experimentation does not silently discard settings.

Update `config.example.json` and `README.md` with a four-level example and practical guidance:

- `none` preserves crisp regions and produces only direct nearest-tone quantization;
- `atkinson` applies restrained diffusion that often suits text-heavy dashboards;
- `floyd-steinberg` preserves gradients more aggressively;
- PNG is required when the decoded image must contain exactly four tones.

## Verification

- Configuration tests cover the `256` default, valid four-level grayscale, the `2` and `256` boundaries, invalid level counts, and mode/dither compatibility.
- Pixel tests assert the exact four-tone palette, every nearest-tone boundary, and deterministic Floyd–Steinberg and Atkinson output.
- Regression tests confirm current 256-level grayscale and threshold-based monochrome output remain unchanged.
- Composition tests cover inversion, every rotation, PNG and JPEG, and exact final dimensions.
- PNG integration tests assert an indexed two-bit result and confirm that decoding yields only `0`, `85`, `170`, and `255`.
- Capture tests verify `--disable-lcd-text` is passed to Chromium.
- Processing failures continue to retain the previous successful image and clean up both temporary files.
- Run `npm test`, validate the Compose configuration, and visually compare representative Home Assistant text, icons, flat fills, and gradients on a four-level panel or faithful emulator.

## Acceptance criteria

- A grayscale task configured with `levels: 4` emits exactly four luminance values.
- Dithering is optional and independently selectable for four-level output.
- All dithering modes are deterministic across repeated captures in the supported container.
- Text begins with grayscale rather than RGB subpixel antialiasing before quantization.
- Four-level PNG output is encoded at two bits per sample without a second quantization pass changing pixels.
- Existing configurations remain valid and retain their current defaults.
- Existing monochrome behavior, atomic replacement, error retention, and exact-dimension guarantees remain intact.

## Non-goals

Do not disable all browser antialiasing, expose arbitrary Chromium arguments, add public transformation parameters, or implement controller-specific raw framebuffer formats in this change. Custom nonuniform palettes and panel calibration can follow once their configuration and preview behavior are defined.
