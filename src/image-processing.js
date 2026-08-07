import sharp from "sharp";

export function captureDimensions(task) {
  return [90, 270].includes(task.imageProcessing.rotation)
    ? { width: task.height, height: task.width }
    : { width: task.width, height: task.height };
}

function luminance(red, green, blue) {
  return Math.round((54 * red + 183 * green + 19 * blue) / 256);
}

function diffuse(values, width, height, x, y, error, offsets) {
  for (const [offsetX, offsetY, weight] of offsets) {
    const targetX = x + offsetX;
    const targetY = y + offsetY;
    if (targetX >= 0 && targetX < width && targetY >= 0 && targetY < height) {
      values[targetY * width + targetX] += error * weight;
    }
  }
}

function monochrome(values, width, height, threshold, dither) {
  const offsets = dither === "floyd-steinberg"
    ? [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]
    : [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const original = Math.max(0, Math.min(255, values[index]));
      const output = original >= threshold ? 255 : 0;
      values[index] = output;
      if (dither !== "none") diffuse(values, width, height, x, y, original - output, offsets);
    }
  }
}

export async function processImage(sourcePath, outputPath, task) {
  const expectedSource = captureDimensions(task);
  const { data, info } = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== expectedSource.width || info.height !== expectedSource.height) {
    throw new Error(`Captured image dimensions ${info.width}x${info.height} do not match expected ${expectedSource.width}x${expectedSource.height}`);
  }

  const pixels = Buffer.from(data);
  if (task.imageProcessing.mode === "grayscale") {
    for (let index = 0; index < info.width * info.height; index += 1) {
      const offset = index * 4;
      const tone = luminance(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      pixels[offset] = tone;
      pixels[offset + 1] = tone;
      pixels[offset + 2] = tone;
    }
  } else if (task.imageProcessing.mode === "monochrome") {
    const tones = new Float32Array(info.width * info.height);
    for (let index = 0; index < tones.length; index += 1) {
      const offset = index * 4;
      tones[index] = luminance(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    }
    monochrome(tones, info.width, info.height, task.imageProcessing.threshold, task.imageProcessing.dither);
    for (let index = 0; index < tones.length; index += 1) {
      const offset = index * 4;
      const tone = Math.round(tones[index]);
      pixels[offset] = tone;
      pixels[offset + 1] = tone;
      pixels[offset + 2] = tone;
    }
  }
  if (task.imageProcessing.invert) {
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 255 - pixels[offset];
      pixels[offset + 1] = 255 - pixels[offset + 1];
      pixels[offset + 2] = 255 - pixels[offset + 2];
    }
  }

  let output = sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4 } })
    .rotate(task.imageProcessing.rotation);
  output = task.format === "jpeg"
    ? output.flatten({ background: "#ffffff" }).jpeg({ quality: task.jpegQuality, chromaSubsampling: "4:4:4" })
    : output.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false });
  await output.toFile(outputPath);

  const metadata = await sharp(outputPath).metadata();
  const expectedFormat = task.format === "jpeg" ? "jpeg" : "png";
  if (metadata.width !== task.width || metadata.height !== task.height || metadata.format !== expectedFormat) {
    throw new Error(`Processed image must be ${task.width}x${task.height} ${expectedFormat}`);
  }
}
