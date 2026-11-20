const samplingGrid = (size: number) =>
  Array.from({ length: 256 }, (_, byte) => {
    const position = (byte * (size - 1)) / 255;
    const low = Math.min(size - 2, Math.floor(position));
    return { low, fraction: position - low };
  });

const grids = new Map<number, ReturnType<typeof samplingGrid>>();

const interpolate = (from: number, to: number, fraction: number) =>
  from + (to - from) * fraction;

/** Apply a trilinear RGB cube to unpremultiplied bytes, keeping alpha. */
export function applyFilmGrade(
  data: Uint8ClampedArray,
  cube: Uint8Array,
  size: number,
) {
  const [dx, dy, dz] = [4, 4 * size, 4 * size * size];
  const grid = grids.get(size) ?? samplingGrid(size);
  grids.set(size, grid);
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3] === 0) continue;
    const red = grid[data[at]!]!;
    const green = grid[data[at + 1]!]!;
    const blue = grid[data[at + 2]!]!;
    const corner = red.low * dx + green.low * dy + blue.low * dz;
    for (let channel = 0; channel < 3; channel++) {
      const c = corner + channel;
      const low =
        interpolate(cube[c]!, cube[c + dx]!, red.fraction) *
          (1 - green.fraction) +
        interpolate(cube[c + dy]!, cube[c + dy + dx]!, red.fraction) *
          green.fraction;
      const high =
        interpolate(cube[c + dz]!, cube[c + dz + dx]!, red.fraction) *
          (1 - green.fraction) +
        interpolate(cube[c + dz + dy]!, cube[c + dz + dy + dx]!, red.fraction) *
          green.fraction;
      data[at + channel] = interpolate(low, high, blue.fraction);
    }
  }
}
