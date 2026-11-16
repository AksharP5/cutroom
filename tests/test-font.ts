/**
 * A real TrueType font, built in memory so no font binary is committed: every printable ASCII
 * character is the same solid block, 600 units wide and as tall as a capital, and a space is
 * empty. Text set in it is unmistakable in a frame, and browsers load it like any font.
 */
export function blockFont({
  family,
  weight = 400,
  italic = false,
}: {
  family: string;
  weight?: number;
  italic?: boolean;
}): Uint8Array<ArrayBuffer> {
  const u16 = (...values: number[]) => {
    const out = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => out.writeUInt16BE(value & 0xffff, i * 2));
    return out;
  };
  const u32 = (...values: number[]) => {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, i) => out.writeUInt32BE(value >>> 0, i * 4));
    return out;
  };
  const style = italic ? "Italic" : "Regular";
  const nameTable = () => {
    const names: [number, string][] = [
      [1, family],
      [2, style],
      [4, `${family} ${style}`],
      [6, `${family.replace(/[^A-Za-z0-9]/g, "")}-${style}`],
    ];
    const strings = names.map(([, text]) =>
      Buffer.from(text, "utf16le").swap16(),
    );
    let offset = 0;
    const records = names.map(([id], i) => {
      const record = u16(3, 1, 0x409, id, strings[i]!.length, offset);
      offset += strings[i]!.length;
      return record;
    });
    return Buffer.concat([
      u16(0, names.length, 6 + names.length * 12),
      ...records,
      ...strings,
    ]);
  };
  // Glyph 1, the block: one clockwise contour of four on-curve points.
  const block = Buffer.concat([
    u16(1, 50, 0, 550, 700),
    u16(3, 0),
    Buffer.from([1, 1, 1, 1]),
    u16(50, 0, 500, 0),
    u16(0, 700, 0, -700),
  ]);
  const glyphs = 94;
  const os2 = Buffer.alloc(96);
  os2.writeUInt16BE(4, 0);
  os2.writeInt16BE(600, 2);
  os2.writeUInt16BE(weight, 4);
  os2.writeUInt16BE(5, 6);
  os2.writeUInt16BE(italic ? 0x01 : weight >= 700 ? 0x20 : 0x40, 62);
  os2.writeUInt16BE(0x20, 64);
  os2.writeUInt16BE(0x7e, 66);
  os2.writeInt16BE(800, 68);
  os2.writeInt16BE(-200, 70);
  os2.writeUInt16BE(800, 74);
  os2.writeUInt16BE(200, 76);
  os2.writeUInt32BE(1, 78);
  os2.writeInt16BE(500, 86);
  os2.writeInt16BE(700, 88);
  os2.writeUInt16BE(0x20, 92);
  const tables: Record<string, Buffer> = {
    "OS/2": os2,
    cmap: Buffer.concat([
      u16(0, 1),
      u16(3, 1),
      u32(12),
      u16(4, 16 + 3 * 8 + glyphs * 2, 0, 6, 4, 1, 2),
      u16(0x20, 0x7e, 0xffff),
      u16(0),
      u16(0x20, 0x21, 0xffff),
      u16(2 - 0x20, 0, 1),
      u16(0, 4, 0),
      u16(...Array.from({ length: glyphs }, () => 1)),
    ]),
    glyf: block,
    head: Buffer.concat([
      u32(0x00010000, 0x00010000, 0, 0x5f0f3cf5),
      u16(0x000b, 1000),
      Buffer.alloc(16),
      u16(50, 0, 550, 700, italic ? 2 : weight >= 700 ? 1 : 0, 8, 2, 0, 0),
    ]),
    hhea: Buffer.concat([
      u32(0x00010000),
      u16(800, -200, 0, 600, 0, 0, 550, 1, 0, 0, 0, 0, 0, 0, 0, 3),
    ]),
    hmtx: u16(600, 0, 600, 50, 300, 0),
    loca: u16(0, 0, block.length / 2, block.length / 2),
    maxp: Buffer.concat([
      u32(0x00010000),
      u16(3, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0),
    ]),
    name: nameTable(),
    post: Buffer.concat([
      u32(0x00030000, 0),
      u16(-100, 50),
      u32(0, 0, 0, 0, 0),
    ]),
  };
  const tags = Object.keys(tables).sort();
  const sum = (data: Buffer) => {
    const padded = Buffer.concat([
      data,
      Buffer.alloc((4 - (data.length % 4)) % 4),
    ]);
    let total = 0;
    for (let i = 0; i < padded.length; i += 4)
      total = (total + padded.readUInt32BE(i)) >>> 0;
    return total;
  };
  const header = Buffer.concat([
    u32(0x00010000),
    u16(tags.length, 128, 3, tags.length * 16 - 128),
  ]);
  let offset = 12 + tags.length * 16;
  const directory: Buffer[] = [];
  const bodies: Buffer[] = [];
  for (const tag of tags) {
    const data = tables[tag]!;
    directory.push(
      Buffer.concat([
        Buffer.from(tag, "latin1"),
        u32(sum(data), offset, data.length),
      ]),
    );
    const padded = Buffer.concat([
      data,
      Buffer.alloc((4 - (data.length % 4)) % 4),
    ]);
    bodies.push(padded);
    offset += padded.length;
  }
  const file = Buffer.concat([header, ...directory, ...bodies]);
  // head.checkSumAdjustment makes the whole file sum to the magic number.
  const headOffset =
    12 +
    tags.length * 16 +
    bodies
      .slice(0, tags.indexOf("head"))
      .reduce((total, body) => total + body.length, 0);
  file.writeUInt32BE((0xb1b0afba - sum(file)) >>> 0, headOffset + 8);
  return new Uint8Array(file);
}
