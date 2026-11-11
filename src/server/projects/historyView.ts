import { readFileSync } from "node:fs";
import { plugin } from "bun";
import { ProjectDocumentSchema } from "../../shared/project";

/** Only view preferences are excluded. Invalid documents remain byte-for-byte recoverable. */
export function historyDocument(bytes: Uint8Array) {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("view" in value) ||
      !ProjectDocumentSchema.safeParse(value).success
    )
      return bytes;
    const { view: _view, ...content } = value;
    return Buffer.from(`${JSON.stringify(content, null, 2)}\n`);
  } catch {
    return bytes;
  }
}

/** The pinned history API snapshots entire files and has no host field filter. */
export function adaptHistory(source: string) {
  const replace = (before: string, after: string) => {
    if (source.split(before).length !== 2)
      throw new Error(
        "Cutroom's view-settings history adapter needs review for this HyperFrames version.",
      );
    source = source.replace(before, after);
  };
  replace(
    "const after = hashOfVersion(version);\n      if (!after",
    `const document = absPath === join8(this.dir, "cutroom.json");
      if (document) bytes = cutroomHistoryDocument(bytes);
      const after = document ? hashOfVersion(fileContentVersion(cutroomHistoryDocument(readFileSync10(absPath)))) : hashOfVersion(version);
      if (!after`,
  );
  replace(
    "async function openBlobStore(dir) {",
    "async function openBlobStore(dir, cutroomProjectDir) {",
  );
  replace(
    'const blobs = await openBlobStore(join8(options.historyRoot, projectId, "blobs"));',
    'const blobs = await openBlobStore(join8(options.historyRoot, projectId, "blobs"), options.projectDir);',
  );
  replace(
    "if (small) return putBytes(small.bytes, small.mode);",
    'if (small) return putBytes(cutroomProjectDir && absPath === join2(resolve2(cutroomProjectDir), "cutroom.json") ? cutroomHistoryDocument(small.bytes) : small.bytes, small.mode);',
  );
  replace(
    "const absPath = join8(this.dir, path);\n    const { writeToken }",
    `const absPath = join8(this.dir, path);
    let view;
    if (path === "cutroom.json") {
      try { view = JSON.parse(readFileSync10(absPath, "utf8")).view; } catch {}
    }
    const { writeToken }`,
  );
  replace(
    "await this.blobs.writeTo(hash, absPath, () => this.assertWritable());",
    `await this.blobs.writeTo(hash, absPath, () => this.assertWritable());
      if (view !== undefined) {
        const restored = JSON.parse(readFileSync10(absPath, "utf8"));
        replaceFileAtomically6(absPath, JSON.stringify({ ...restored, view }, null, 2) + "\\n", 384);
      }`,
  );
  return `import { historyDocument as cutroomHistoryDocument } from ${JSON.stringify(import.meta.path)};\n${source}`;
}

const manifest: unknown = JSON.parse(
  readFileSync(
    new URL(
      "../package.json",
      import.meta.resolve("@hyperframes/studio-server"),
    ),
    "utf8",
  ),
);
if (
  !manifest ||
  typeof manifest !== "object" ||
  !("version" in manifest) ||
  manifest.version !== "0.9.26"
)
  throw new Error(
    "Cutroom's view-settings history adapter requires Studio Server 0.9.26.",
  );

plugin({
  name: "cutroom-history-view",
  setup(build) {
    build.onLoad(
      {
        filter:
          /[\\/]@hyperframes[\\/]studio-server[\\/]dist[\\/]chunk-.*\.js$/,
      },
      ({ path }) => {
        const source = readFileSync(path, "utf8");
        if (!source.includes("async storeIfPresent(path)"))
          return { contents: source, loader: "js" };
        return { contents: adaptHistory(source), loader: "js" };
      },
    );
  },
});
