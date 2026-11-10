import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { z } from "zod";
import { createApp } from "../src/server/app";
import { FilmstripSchema } from "../src/server/media/protocol";
import { mediaSettings, peakLevels } from "../src/shared/media";

const output = await mkdtemp(join(tmpdir(), "cutroom-media-bench-"));
const runtime = await createApp({
  dataDir: join(output, "data"),
  projectsDir: join(output, "projects"),
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: runtime.app.fetch,
});
const origin = server.url.origin;
const browser = await chromium.launch({
  executablePath: process.env.CUTROOM_BROWSER_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--mute-audio"],
});
async function size(
  directory: string,
): Promise<{ bytes: number; allocatedBytes: number }> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return size(path);
      const info = await stat(path);
      return { bytes: info.size, allocatedBytes: info.blocks * 512 };
    }),
  );
  return sizes.reduce(
    (sum, item) => ({
      bytes: sum.bytes + item.bytes,
      allocatedBytes: sum.allocatedBytes + item.allocatedBytes,
    }),
    { bytes: 0, allocatedBytes: (await stat(directory)).blocks * 512 },
  );
}
async function ffmpeg(args: string[]) {
  const child = Bun.spawn(["ffmpeg", "-nostdin", "-v", "error", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const errors = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(errors);
}
async function ready(url: string) {
  const deadline = performance.now() + 120000;
  while (true) {
    const response = await fetch(url);
    if (response.status !== 202) {
      if (response.status !== 200) throw new Error(await response.text());
      return response;
    }
    await response.arrayBuffer();
    if (performance.now() > deadline)
      throw new Error("Media benchmark timed out.");
    await Bun.sleep(5);
  }
}
const results = [];
try {
  const project = await runtime.projects.create({
    name: "60s 1080p media benchmark",
    duration: 60,
  });
  const source = join(project.path, "sample.mp4");
  const command = [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1920x1080:rate=30000/1001:duration=60",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=60",
    "-af",
    "volume=0.2+0.8*abs(sin(PI*t/6)):eval=frame",
    "-vf",
    "drawbox=c=blue:t=fill:enable='between(t,0.8,1.199)'",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-g",
    "60",
    "-keyint_min",
    "60",
    "-sc_threshold",
    "0",
    "-threads",
    "2",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    source,
  ];
  await ffmpeg(command);
  const probe = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=duration",
      "-of",
      "json",
      source,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const probeOutput: unknown = await new Response(probe.stdout).json();
  const probeError = await new Response(probe.stderr).text();
  if ((await probe.exited) !== 0) throw new Error(probeError);
  const videoDuration = z
    .object({
      streams: z
        .array(z.object({ duration: z.coerce.number().positive() }))
        .min(1),
    })
    .parse(probeOutput).streams[0]!.duration;
  const base = `${origin}/api/cutroom/projects/${project.id}/media`;
  for (const kind of ["peaks", "filmstrip", "frame"] as const) {
    const url = `${base}/${kind}?path=sample.mp4${kind === "frame" ? "&time=1" : ""}`;
    const health: number[] = [];
    let measuring = true;
    const healthTask = (async () => {
      while (measuring) {
        const start = performance.now();
        const response = await fetch(`${origin}/health`);
        await response.arrayBuffer();
        health.push(performance.now() - start);
        await Bun.sleep(10);
      }
    })();
    const started = performance.now();
    const first = await fetch(url);
    const admittedMs = performance.now() - started;
    const firstStatus = first.status;
    await first.arrayBuffer();
    const response = await ready(url);
    const payload = Buffer.from(await response.arrayBuffer());
    const coldMs = performance.now() - started;
    measuring = false;
    await healthTask;
    const warm: number[] = [];
    for (let index = 0; index < 30; index++) {
      const start = performance.now();
      const cached = await fetch(url);
      await cached.arrayBuffer();
      if (cached.status !== 200) throw new Error("Warm cache response failed.");
      warm.push(performance.now() - start);
    }
    warm.sort((a, b) => a - b);
    await Bun.write(
      join(
        output,
        kind === "peaks"
          ? "peaks.bin"
          : kind === "frame"
            ? "frame.jpg"
            : "filmstrip.json",
      ),
      payload,
    );
    results.push({
      kind,
      firstStatus,
      admittedMs,
      coldMs,
      warmMedianMs: (warm[14]! + warm[15]!) / 2,
      warmP95Ms: warm[28],
      healthMaxMs: Math.max(...health),
      healthSamples: health.length,
    });
  }
  const mainCache = await size(join(project.path, ".cutroom/cache"));
  const metadata = FilmstripSchema.extend({
    sheets: z.array(
      FilmstripSchema.shape.sheets.element.extend({ spriteUrl: z.string() }),
    ),
  }).parse(await Bun.file(join(output, "filmstrip.json")).json());
  const expectedTiles = Math.ceil(
    videoDuration / mediaSettings.filmstripInterval,
  );
  if (metadata.count !== expectedTiles)
    throw new Error(
      `Expected ${expectedTiles} NTSC tiles, received ${metadata.count}.`,
    );
  for (const sheet of metadata.sheets)
    await Bun.write(
      join(output, `sprite-${sheet.index}.jpg`),
      await fetch(`${origin}${sheet.spriteUrl}`),
    );
  const peaks = Buffer.from(
    await Bun.file(join(output, "peaks.bin")).arrayBuffer(),
  );
  const levels = Array.from({ length: peaks.readUInt32LE(8) }, (_, level) => {
    const entry = 32 + level * 16;
    return {
      secondsPerPair: peaks.readUInt32LE(entry) / peaks.readUInt32LE(12),
      pairs: peaks.readUInt32LE(entry + 4),
      offset: peaks.readUInt32LE(entry + 8),
      bytes: peaks.readUInt32LE(entry + 12),
    };
  });
  const overview = Buffer.from(
    await (
      await ready(`${base}/peaks?path=sample.mp4&level=2&start=0&end=60`)
    ).arrayBuffer(),
  );
  await Bun.write(join(output, "overview.bin"), overview);
  // A lossless impulse fixture makes the maximum-zoom comparison independent of AAC smearing.
  const pcm = Buffer.alloc(48000 * 2);
  for (let sample = 24000; sample < 24024; sample++)
    pcm.writeInt16LE(29000, sample * 2);
  for (let sample = 24384; sample < 24408; sample++)
    pcm.writeInt16LE(-29000, sample * 2);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF");
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  await Bun.write(join(project.path, "impulses.wav"), wav);
  await Bun.write(join(output, "impulses.pcm"), pcm);
  const detail = Buffer.from(
    await (
      await ready(`${base}/peaks?path=impulses.wav&level=0&start=0.4&end=0.7`)
    ).arrayBuffer(),
  );
  await Bun.write(join(output, "detail.bin"), detail);
  const report = {
    runtime: `Bun ${Bun.version}`,
    cpu: cpus()[0]?.model,
    sample:
      "60s 1920x1080 29.97fps H.264 + AAC, 60-frame GOP, blue shot at 0.8–1.2s",
    source,
    frameRate: "30000/1001",
    gopFrames: 60,
    videoDuration,
    filmstripTiles: metadata.count,
    expectedTiles,
    command: ["ffmpeg", "-nostdin", "-v", "error", ...command],
    warmRuns: 30,
    results,
    cacheBytes: mainCache.bytes,
    cacheAllocatedBytes: mainCache.allocatedBytes,
    peaksHeaderBytes: 32 + peakLevels.length * 16,
    levels,
    overviewResponseBytes: overview.length,
    detailResponseBytes: detail.length,
    output,
  };
  await writeFile(
    join(output, "metrics.json"),
    JSON.stringify(report, null, 2),
  );
  const image = (path: string) =>
    Bun.file(join(output, path))
      .arrayBuffer()
      .then((bytes) => Buffer.from(bytes).toString("base64"));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#0e0e10;color:#e8e8ea;font:16px sans-serif}main{padding:32px}h1{font-size:26px;margin:0 0 8px}p{color:#9a9aa2;margin:0 0 16px}h2{font-size:16px;margin:20px 0 10px}canvas{display:block;background:#151517}#overview{width:100%;height:150px}.row{display:flex;gap:28px;align-items:flex-start}.detail{width:576px}.detail p{font-size:13px;margin-top:8px}.frame img{height:180px;image-rendering:auto}#sprite{width:100%;height:auto}.time{display:flex;justify-content:space-between;color:#9a9aa2;font:12px monospace;margin-top:6px}#chart{width:100%;height:160px}
  </style></head><body><main><h1>Cutroom media detail</h1><p>60 seconds · 1920×1080 · 29.97 fps · 48 kHz peaks across channels · native-frame seeking</p>
  <h2>Overview · 32 ms buckets · ${overview.length.toLocaleString()} bytes downloaded · display gain ×7.1</h2><canvas id="overview" width="1600" height="150"></canvas><div class="time"><span>00:00</span><span>00:15</span><span>00:30</span><span>00:45</span><span>01:00</span></div>
  <div class="row"><div class="detail"><h2>Maximum zoom · 32 px/frame at 60 fps</h2><canvas id="detail" width="576" height="140"></canvas><div class="time"><span>0.400 s</span><span>0.500 s</span><span>0.600 s</span><span>0.700 s</span></div><p>2 ms buckets. Two lossless impulses, 8 ms apart. Unity gain.</p></div><div class="frame"><h2>On-demand frame · 1.000 s</h2><img src="data:image/jpeg;base64,${await image("frame.jpg")}"><p>The blue shot at 0.8–1.2 s falls inside overview tile 0.</p></div></div>
  <h2>Overview filmstrip · keyframes · ${metadata.count} tiles · ${metadata.tileWidth}×${mediaSettings.tileHeight}</h2><img id="sprite" src="data:image/jpeg;base64,${await image("sprite-0.jpg")}">
  <h2>Cold generation and cached responses · milliseconds</h2><canvas id="chart" width="1600" height="160"></canvas>
  </main><script>
  function draw(id,raw,start,end,gain){const data=Uint8Array.from(atob(raw),c=>c.charCodeAt(0)),v=new DataView(data.buffer),c=document.getElementById(id),ctx=c.getContext('2d'),n=v.getUint32(36,true),off=v.getUint32(40,true),first=v.getUint32(28,true),width=v.getUint32(32,true)/v.getUint32(12,true);ctx.strokeStyle='#2a2a2e';ctx.beginPath();ctx.moveTo(0,c.height/2);ctx.lineTo(c.width,c.height/2);ctx.stroke();ctx.fillStyle='#4da66c';for(let i=0;i<n;i++){const x=((first+i)*width-start)/(end-start)*c.width,w=width/(end-start)*c.width,min=v.getInt16(off+i*4,true),max=v.getInt16(off+i*4+2,true);ctx.fillRect(x,c.height/2-max/32768*c.height/2*gain,Math.max(1,w),Math.max(1,(max-min)/32768*c.height/2*gain));}}
  draw('overview','${overview.toString("base64")}',0,60,7.1);draw('detail','${detail.toString("base64")}',0.4,0.7,1);
  const cx=document.getElementById('chart').getContext('2d'),rows=${JSON.stringify(results)};cx.font='16px sans-serif';rows.forEach((r,i)=>{let y=6+i*50;cx.fillStyle='#e8e8ea';cx.fillText(r.kind,0,y+14);cx.fillStyle='#3b6ea8';cx.fillRect(110,y,Math.max(1,r.coldMs/Math.max(...rows.map(r=>r.coldMs))*900),16);cx.fillStyle='#df764c';cx.fillRect(110,y+19,Math.max(2,r.warmMedianMs/Math.max(...rows.map(r=>r.coldMs))*900),10);cx.fillStyle='#9a9aa2';cx.fillText('cold '+r.coldMs.toFixed(1)+' ms · warm median '+r.warmMedianMs.toFixed(2)+' ms',1050,y+16);});
  </script></body></html>`;
  await writeFile(join(output, "evidence.html"), html);
  const page = await browser.newPage({
    viewport: { width: 1720, height: 1050 },
    colorScheme: "dark",
  });
  await page.setContent(html);
  await page.screenshot({
    path: join(output, "media-output.png"),
    fullPage: true,
  });
  await page
    .locator("#detail")
    .screenshot({ path: join(output, "peaks-max-zoom.png") });
  await page
    .locator(".frame")
    .screenshot({ path: join(output, "on-demand-frame.png") });
  await page
    .locator("#sprite")
    .screenshot({ path: join(output, "filmstrip.png") });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await runtime.dispose();
  await server.stop(true);
}
