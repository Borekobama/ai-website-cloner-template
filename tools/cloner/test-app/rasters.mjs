// Synthetic rasters for image-measurement tests. Shapes are painted with
// exact pixel coverage, so a test knows the true sub-pixel position of every
// edge.

export function blendPixel(raster, x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height || alpha <= 0) return;
  const offset = (y * raster.width + x) * 4;
  for (let channel = 0; channel < 3; channel += 1) {
    raster.data[offset + channel] = Math.round(raster.data[offset + channel] * (1 - alpha) + color[channel] * alpha);
  }
  raster.data[offset + 3] = 255;
}

// [x0, y0, x1, y1] in continuous pixel coordinates; pixel x covers [x, x + 1).
export function paintRect(raster, [x0, y0, x1, y1], color, alpha = 1) {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(raster.height, Math.ceil(y1)); y += 1) {
    const coverY = Math.min(y + 1, y1) - Math.max(y, y0);
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(raster.width, Math.ceil(x1)); x += 1) {
      blendPixel(raster, x, y, color, alpha * coverY * (Math.min(x + 1, x1) - Math.max(x, x0)));
    }
  }
}

function insideRoundedRect(x, y, [x0, y0, x1, y1], radius) {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const centerX = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const centerY = Math.min(Math.max(y, y0 + radius), y1 - radius);
  return (x - centerX) ** 2 + (y - centerY) ** 2 <= radius * radius;
}

// Corner pixels are supersampled; the straight parts use exact coverage.
export function paintRoundedRect(raster, box, radius, color, samples = 16) {
  const [x0, y0, x1, y1] = box;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(raster.height, Math.ceil(y1)); y += 1) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(raster.width, Math.ceil(x1)); x += 1) {
      const inCorner = (x < x0 + radius || x + 1 > x1 - radius) && (y < y0 + radius || y + 1 > y1 - radius);
      let alpha;
      if (inCorner) {
        let inside = 0;
        for (let sampleY = 0; sampleY < samples; sampleY += 1) {
          for (let sampleX = 0; sampleX < samples; sampleX += 1) {
            if (insideRoundedRect(x + (sampleX + 0.5) / samples, y + (sampleY + 0.5) / samples, box, radius)) inside += 1;
          }
        }
        alpha = inside / (samples * samples);
      } else {
        alpha = (Math.min(x + 1, x1) - Math.max(x, x0)) * (Math.min(y + 1, y1) - Math.max(y, y0));
      }
      blendPixel(raster, x, y, color, alpha);
    }
  }
}

// An app frame on a backdrop with a soft drop shadow, like a presentation shot.
export function paintPresentationFrame(raster, frameBox, { canvas = [239, 238, 243], shadow = true } = {}) {
  if (shadow) {
    for (let spread = 24; spread >= 1; spread -= 1) {
      paintRect(raster, [frameBox[0] - spread, frameBox[1] - spread + 8, frameBox[2] + spread, frameBox[3] + spread + 8], [0, 0, 0], 0.006);
    }
  }
  paintRect(raster, frameBox, canvas);
}
