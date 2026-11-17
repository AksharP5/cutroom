import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { z } from "zod";
import {
  decodeAuthoredAttribute,
  scanHtmlOpeningTags,
} from "@hyperframes/parsers";
import { rewriteAssetPath } from "@hyperframes/parsers/asset-paths";
import {
  buildVariablesByCompScript,
  parseHostVariableValues,
} from "@hyperframes/core/compiler";
import { resolveWithinProject } from "@hyperframes/core/safe-path";
import { readProjectFile } from "@hyperframes/parsers/asset-resolution";
import { localMediaPath } from "../../shared/media.ts";
import {
  parseDeclarations,
  rewriteImageDeclarationUrls,
} from "../../shared/variables.ts";

const declarationAttribute = "data-composition-variables";

/** Inspector values are paths relative to the selected composition. */
export function rebaseImageOverrides(
  dir: string,
  composition: string,
  values: Record<string, unknown>,
) {
  if (!composition.includes("/")) return values;
  let rebased = values;
  for (const id of sceneImageIds(dir, composition)) {
    const value = values[id];
    if (typeof value !== "string") continue;
    const url = rebaseImageUrl(dir, composition, value);
    if (url === value) continue;
    if (rebased === values) rebased = { ...values };
    rebased[id] = url;
  }
  return rebased;
}

function rebaseImageUrl(dir: string, composition: string, value: string) {
  const path = localMediaPath(composition, value);
  if (path === null || path === ".." || path.startsWith("../")) return value;
  return rewriteAssetPath(composition, value, (path) =>
    existsSync(resolve(dir, path)),
  );
}

function sceneImageIds(dir: string, composition: string) {
  const file = resolveWithinProject(dir, composition);
  if (!file) return [];
  const source = readProjectFile(file);
  if (source.kind !== "file") return [];
  return new Set(
    scanHtmlOpeningTags(source.text).flatMap(({ attributes }) =>
      attributes.flatMap((attr) =>
        attr.kind === "value" && attr.name === declarationAttribute
          ? parseDeclarations(decodeAuthoredAttribute(attr.value)).flatMap(
              (variable) => (variable.type === "image" ? [variable.id] : []),
            )
          : [],
      ),
    ),
  );
}

const scopedVariablesPrefix =
  "window.__hfVariablesByComp = Object.assign({}, window.__hfVariablesByComp || {}, ";

const scopedVariables = z.record(z.string(), z.record(z.string(), z.unknown()));

function readScopedVariables(script: string) {
  if (!script.endsWith(");")) return;
  try {
    return scopedVariables.parse(
      JSON.parse(script.slice(scopedVariablesPrefix.length, -2)),
    );
  } catch {
    // Only the compiler's JSON table uses this format.
  }
}

/** The browser loads compiled HTML from the project root, including standalone scene documents. */
export function rebaseCompiledImageVariables(
  html: string,
  dir: string,
  entryFile: string,
  overrides?: Record<string, unknown>,
) {
  if (
    !html.includes(declarationAttribute) &&
    !html.includes(scopedVariablesPrefix)
  )
    return html;
  const { document } = parseHTML(html);
  const sceneIds = new Map<string, Iterable<string>>();
  // HyperFrames emits this table before any scene scripts and reads it for both
  // getVariables() and data-var-src inside a mounted scene.
  const table = Array.from(document.head.querySelectorAll("script")).find(
    (script) => script.textContent?.startsWith(scopedVariablesPrefix),
  );
  let changed = false;
  let mountedEntry = false;
  const values = table?.textContent && readScopedVariables(table.textContent);
  if (table && values) {
    for (const host of document.querySelectorAll(
      "[data-composition-id][data-composition-file]",
    )) {
      const id = host.getAttribute("data-composition-id")!;
      const composition = host.getAttribute("data-composition-file")!;
      const scoped = values[id];
      if (composition === entryFile) mountedEntry = true;
      if (!scoped) continue;
      const ids = sceneIds.get(composition) ?? sceneImageIds(dir, composition);
      sceneIds.set(composition, ids);
      const authored = parseHostVariableValues(host);
      for (const variable of ids) {
        const value = scoped[variable];
        if (
          composition === entryFile &&
          overrides &&
          Object.hasOwn(overrides, variable)
        ) {
          // A template export mounts its entry in the index's shell. The
          // runtime reads the mount's table instead of the global overrides.
          scoped[variable] = overrides[variable];
          changed = true;
        } else if (!Object.hasOwn(authored, variable)) {
          if (typeof value === "string") {
            scoped[variable] = rebaseImageUrl(dir, composition, value);
          } else if (
            value &&
            typeof value === "object" &&
            "url" in value &&
            typeof value.url === "string"
          ) {
            const url = rebaseImageUrl(dir, composition, value.url);
            if (url !== value.url) scoped[variable] = { ...value, url };
          }
          changed ||= scoped[variable] !== value;
        }
      }
    }
    if (changed) table.textContent = buildVariablesByCompScript(values);
  }
  for (const declaration of document.querySelectorAll(
    `[${declarationAttribute}]`,
  )) {
    const path =
      declaration
        .closest("[data-composition-file]")
        ?.getAttribute("data-composition-file") ??
      (mountedEntry ? "index.html" : entryFile);
    if (!path.includes("/")) continue;
    const value = declaration.getAttribute(declarationAttribute)!;
    const next = rewriteImageDeclarationUrls(value, (url) =>
      rebaseImageUrl(dir, path, url),
    );
    if (next === value) continue;
    declaration.setAttribute(declarationAttribute, next);
    changed = true;
  }
  return changed ? document.toString() : html;
}
