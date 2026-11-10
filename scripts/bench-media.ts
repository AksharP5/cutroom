import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { z } from "zod";
import { createApp } from "../src/server/app";
import { FilmstripSchema } from "../src/server/media/protocol";

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
const results = [];
try {
  const project = await runtime.projects.create({
    name: "60s 1080p media benchmark",
    duration: 60,
  });
  const samplePath = join(project.path, "sample.mp4");
  const command = [
    "ffmpeg",
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1920x1080:rate=30:duration=60",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=60",
    "-af",
    "volume=0.2+0.8*abs(sin(PI*t/6)):eval=frame",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-threads",
    "2",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    samplePath,
  ];
  const generate = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  const errors = await new Response(generate.stderr).text();
  if ((await generate.exited) !== 0) throw new Error(errors);
  for (const kind of ["peaks", "filmstrip"] as const) {
    const url = `${origin}/api/cutroom/projects/${project.id}/media/${kind}?path=sample.mp4`;
    const health: number[] = [];
    let measuring = true;
    const healthTask = (async () => {
      while (measuring) {
        const started = performance.now();
        const response = await fetch(`${origin}/health`);
        await response.arrayBuffer();
        health.push(performance.now() - started);
        await Bun.sleep(10);
      }
    })();
    const started = performance.now();
    let response = await fetch(url);
    const admittedMs = performance.now() - started;
    const firstStatus = response.status;
    const deadline = performance.now() + 120000;
    while (response.status === 202) {
      await response.arrayBuffer();
      if (performance.now() > deadline)
        throw new Error("Media benchmark timed out.");
      await Bun.sleep(5);
      response = await fetch(url);
    }
    const payload = Buffer.from(await response.arrayBuffer());
    const coldMs = performance.now() - started;
    measuring = false;
    await healthTask;
    if (response.status !== 200) throw new Error(payload.toString());
    const warm: number[] = [];
    for (let index = 0; index < 30; index++) {
      const start = performance.now();
      const cached = await fetch(url);
      await cached.arrayBuffer();
      if (cached.status !== 200) throw new Error("Warm cache response failed.");
      warm.push(performance.now() - start);
    }
    warm.sort((a, b) => a - b);
    if (kind === "peaks") await Bun.write(join(output, "peaks.bin"), payload);
    else {
      const metadata = FilmstripSchema.extend({
        key: z.string(),
        spriteUrl: z.string(),
      }).parse(JSON.parse(payload.toString()));
      await Bun.write(
        join(output, "filmstrip.json"),
        JSON.stringify(metadata, null, 2),
      );
      await Bun.write(
        join(output, "sprite.jpg"),
        await fetch(`${origin}${metadata.spriteUrl}`),
      );
    }
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
  const cache = join(project.path, ".cutroom/cache");
  const cacheSize = await size(cache);
  const report = {
    runtime: `Bun ${Bun.version}`,
    cpu: cpus()[0]?.model,
    sample: "60s 1920x1080 30fps H.264 + AAC sine with amplitude envelope",
    samplePath,
    command,
    warmRuns: 30,
    results,
    cacheBytes: cacheSize.bytes,
    cacheAllocatedBytes: cacheSize.allocatedBytes,
    peaksHeaderBytes: 96,
    levels,
    output,
  };
  await writeFile(
    join(output, "metrics.json"),
    JSON.stringify(report, null, 2),
  );
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#0e0e10;color:#e8e8ea;font:16px sans-serif}main{padding:32px}h1{font-size:26px;margin:0 0 8px}p{color:#9a9aa2;margin:0 0 24px}h2{font-size:16px;margin:24px 0 10px}canvas{display:block;width:100%;height:180px;background:#151517}img{display:block;max-width:100%;height:auto}.time{display:flex;justify-content:space-between;font:12px monospace;color:#9a9aa2;margin-top:8px}</style></head><body><main><h1>Cutroom media cache</h1><p>60 seconds · 1920×1080 · 30 fps · testsrc2 + 440 Hz sine with amplitude envelope</p><h2>Waveform · 100 min/max pairs per second · display gain ×7.1</h2><canvas width="1600" height="180"></canvas><div class="time"><span>00:00</span><span>00:15</span><span>00:30</span><span>00:45</span><span>01:00</span></div><h2>Filmstrip · 160×90 tiles every 2 seconds · 30 frames</h2><img src="data:image/jpeg;base64,${Buffer.from(await Bun.file(join(output, "sprite.jpg")).arrayBuffer()).toString("base64")}"><h2>Cold generation and cached reads · milliseconds</h2><canvas id="chart" width="1600" height="180"></canvas></main><script>const raw=Uint8Array.from(atob('${peaks.toString("base64")}'),c=>c.charCodeAt(0));const view=new DataView(raw.buffer);const c=document.querySelector('canvas'),ctx=c.getContext('2d');const offset=view.getUint32(40,true),count=view.getUint32(36,true);ctx.strokeStyle='#4da66c';ctx.lineWidth=1;ctx.beginPath();for(let x=0;x<c.width;x++){let min=32767,max=-32768;for(let i=Math.floor(x*count/c.width);i<Math.ceil((x+1)*count/c.width);i++){min=Math.min(min,view.getInt16(offset+i*4,true));max=Math.max(max,view.getInt16(offset+i*4+2,true));}ctx.moveTo(x,90-max/32768*640);ctx.lineTo(x,90-min/32768*640);}ctx.stroke();const chart=document.getElementById('chart'),cx=chart.getContext('2d');const rows=${JSON.stringify(results)};cx.font='16px sans-serif';rows.forEach((r,i)=>{let y=22+i*80;cx.fillStyle='#e8e8ea';cx.fillText(r.kind,0,y+14);cx.fillStyle='#3b6ea8';cx.fillRect(130,y,Math.max(1,r.coldMs/Math.max(...rows.map(r=>r.coldMs))*900),18);cx.fillStyle='#df764c';cx.fillRect(130,y+26,Math.max(2,r.warmMedianMs/Math.max(...rows.map(r=>r.coldMs))*900),18);cx.fillStyle='#9a9aa2';cx.fillText('cold '+r.coldMs.toFixed(1)+' ms · warm median '+r.warmMedianMs.toFixed(2)+' ms',1060,y+20);});</script></body></html>`;
  await writeFile(join(output, "evidence.html"), html);
  const page = await browser.newPage({
    viewport: { width: 1720, height: 1050 },
    colorScheme: "dark",
  });
  await page.setContent(html);
  await page.screenshot({ path: join(output, "media-output.png") });
  await page.locator("img").screenshot({ path: join(output, "filmstrip.png") });
  await page
    .locator("canvas")
    .first()
    .screenshot({ path: join(output, "peaks.png") });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await runtime.dispose();
  await server.stop(true);
}
