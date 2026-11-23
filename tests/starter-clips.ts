import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Adds the three text clips new projects started with until they began empty, with their styles,
 * for tests written around a project that already has clips: a background on V1, the title on V2
 * and a caption on V3.
 */
export async function addStarterClips(project: { path: string; name: string }) {
  const file = join(project.path, "index.html");
  const page = await readFile(file, "utf8");
  // A project created without a length gets the 12 seconds the starter clips used to last.
  const declared = Number(/<main[^>]*data-duration="([^"]+)"/.exec(page)![1]);
  const duration = declared || 12;
  const name = project.name
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const [width, height] = ["width", "height"].map((side) =>
    Number(new RegExp(`<main[^>]*data-${side}="([^"]+)"`).exec(page)![1]),
  ) as [number, number];
  const styles = `.background { position: absolute; inset: 0; background: #111111; }
.title {
  position: absolute; left: 12%; right: 12%; bottom: 44%; margin: 0;
  font-size: ${Math.round(Math.min(width / 20, height / 9))}px;
  font-weight: 500; letter-spacing: -.035em; line-height: 1.1;
  overflow-wrap: anywhere;
}
.caption {
  position: absolute; left: 12%; right: 12%; top: 61%; margin: 0;
  font-size: ${Math.round(Math.min(width, height) / 36)}px;
  font-weight: 400; line-height: 1.5; color: #a8a8a8;
}
</style>`;
  await writeFile(
    file,
    page
      .replace("</style>", styles)
      .replace(/(<main[^>]*data-duration=")[^"]*"/, `$1${duration}"`)
      .replace(
        "</main>",
        `<div id="rule" class="clip background" data-start="0" data-duration="${duration}" data-track-index="0" data-label="Background"></div>
<div id="headline" class="clip title" data-start="0" data-duration="${duration}" data-track-index="1" data-label="Project title">${name}</div>
<div id="caption" class="clip caption" data-start="0" data-duration="${duration}" data-track-index="2" data-label="Getting started">Drop media in, or ask your agent to start.</div>
</main>`,
      ),
  );
}
