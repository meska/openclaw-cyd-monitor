import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(repositoryRoot, "firmware/assets/status-icon");
const outputPath = resolve(repositoryRoot, "firmware/include/status_icon_sprite.h");
const framePaths = Array.from({ length: 5 }, (_, index) =>
  resolve(sourceDirectory, `live-smile-0${index}.png`),
);

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TRANSPARENT_RGB565 = 0x0001;
const SOURCE_ICON_WIDTH = 32;
const SOURCE_ICON_HEIGHT = 32;
const RENDERED_ICON_WIDTH = 48;
const RENDERED_ICON_HEIGHT = 48;

function paethPredictor(left, above, upperLeft) {
  // El predictor PNG sceglie el vicino piu' credibile senza inventar pixel.
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function decodeRgbaPng(path) {
  const png = readFileSync(path);
  if (png.length < PNG_SIGNATURE.length ||
      !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${path} is not a PNG file`);
  }

  let offset = PNG_SIGNATURE.length;
  let header;
  let sawEnd = false;
  const imageChunks = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > png.length) throw new Error(`${path} contains a truncated PNG chunk`);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = Buffer.from(data);
    if (type === "IDAT") imageChunks.push(Buffer.from(data));
    offset = chunkEnd;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }

  if (!header || header.length !== 13 || imageChunks.length === 0 || !sawEnd) {
    throw new Error(`${path} is missing required PNG chunks`);
  }

  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  // Prima de sgonfiar l'IDAT, blocchemo file enormi o asset della misura sbagliada.
  if (width !== SOURCE_ICON_WIDTH || height !== SOURCE_ICON_HEIGHT) {
    throw new Error(
      `${path} is ${width}x${height}; expected ${SOURCE_ICON_WIDTH}x${SOURCE_ICON_HEIGHT}`,
    );
  }
  const bitDepth = header[8];
  const colorType = header[9];
  const compression = header[10];
  const filterMethod = header[11];
  const interlace = header[12];
  if (bitDepth !== 8 || colorType !== 6 || compression !== 0 ||
      filterMethod !== 0 || interlace !== 0) {
    throw new Error(`${path} must be a non-interlaced 8-bit RGBA PNG`);
  }

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const compressed = Buffer.concat(imageChunks);
  const filtered = inflateSync(compressed);
  if (filtered.length !== (stride + 1) * height) {
    throw new Error(`${path} has an unexpected decompressed size`);
  }

  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[row * (stride + 1)];
    const inputOffset = row * (stride + 1) + 1;
    const outputOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[inputOffset + column];
      const left = column >= bytesPerPixel ? pixels[outputOffset + column - bytesPerPixel] : 0;
      const above = row > 0 ? pixels[outputOffset + column - stride] : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel
        ? pixels[outputOffset + column - stride - bytesPerPixel]
        : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + Math.floor((left + above) / 2);
      else if (filter === 4) value = raw + paethPredictor(left, above, upperLeft);
      else throw new Error(`${path} uses unsupported PNG filter ${filter}`);
      pixels[outputOffset + column] = value & 0xff;
    }
  }

  return { width, height, pixels };
}

function toRgb565Frame(path, expectedWidth, expectedHeight) {
  const { width, height, pixels } = decodeRgbaPng(path);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`${path} is ${width}x${height}; expected ${expectedWidth}x${expectedHeight}`);
  }

  const frame = [];
  for (let outputY = 0; outputY < RENDERED_ICON_HEIGHT; outputY += 1) {
    for (let outputX = 0; outputX < RENDERED_ICON_WIDTH; outputX += 1) {
      // Nearest-neighbour el tien i contorni neti senza inventar mezzi colori.
      const sourceX = Math.floor(outputX * width / RENDERED_ICON_WIDTH);
      const sourceY = Math.floor(outputY * height / RENDERED_ICON_HEIGHT);
      const offset = (sourceY * width + sourceX) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (alpha !== 0 && alpha !== 255) {
        throw new Error(`${path} contains non-binary alpha ${alpha}`);
      }
      if (alpha === 0) {
        frame.push(TRANSPARENT_RGB565);
        continue;
      }
      const rgb565 = ((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3);
      if (rgb565 === TRANSPARENT_RGB565) {
        throw new Error(`${path} contains an opaque pixel matching the transparency key`);
      }
      frame.push(rgb565);
    }
  }
  return frame;
}

function formatFrame(frame) {
  const rows = [];
  for (let offset = 0; offset < frame.length; offset += 16) {
    const values = frame.slice(offset, offset + 16)
      .map((value) => `0x${value.toString(16).padStart(4, "0").toUpperCase()}`);
    rows.push(`    ${values.join(", ")}`);
  }
  return rows.join(",\n");
}

const firstFrame = decodeRgbaPng(framePaths[0]);
const frames = framePaths.map((path) => toRgb565Frame(path, firstFrame.width, firstFrame.height));
const formattedFrames = frames.map((frame) => `  {\n${formatFrame(frame)}\n  }`).join(",\n");
const header = `#pragma once

#include <Arduino.h>

// Genera' dai PNG PixelLab con nearest-neighbour: bordi neti anche a misura piu' granda.
constexpr uint8_t STATUS_ICON_WIDTH = ${RENDERED_ICON_WIDTH};
constexpr uint8_t STATUS_ICON_HEIGHT = ${RENDERED_ICON_HEIGHT};
constexpr uint8_t STATUS_ICON_FRAME_COUNT = ${frames.length};
constexpr uint16_t STATUS_ICON_TRANSPARENT = 0x${TRANSPARENT_RGB565.toString(16).padStart(4, "0").toUpperCase()};

const uint16_t STATUS_ICON_FRAMES[STATUS_ICON_FRAME_COUNT]
                                 [STATUS_ICON_WIDTH * STATUS_ICON_HEIGHT] PROGMEM = {
${formattedFrames}
};

static_assert(sizeof(STATUS_ICON_FRAMES) ==
              STATUS_ICON_FRAME_COUNT * STATUS_ICON_WIDTH * STATUS_ICON_HEIGHT * sizeof(uint16_t));
`;

writeFileSync(outputPath, header);
stdout.write(
  `Generated ${outputPath} from ${frames.length} ${firstFrame.width}x${firstFrame.height} frames ` +
  `rendered at ${RENDERED_ICON_WIDTH}x${RENDERED_ICON_HEIGHT}.\n`,
);
