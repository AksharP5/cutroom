import { posix } from "node:path";
import { parse, serialize } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { fileContentVersion } from "@hyperframes/studio-server";
import { TrackGainPreviewSchema } from "../../shared/preview";

/** Compare rendered content, excluding only managed faders and the compiler's routing identities. */
export function trackGainPreview(html: string, composition = "index.html") {
  const document = parse(html);
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: DefaultTreeAdapterTypes.ParentNode) => {
    node.childNodes = node.childNodes.filter(
      (child) =>
        !(
          "tagName" in child &&
          child.tagName === "meta" &&
          child.attrs.some(
            (attr) =>
              attr.name === "name" &&
              attr.value === "hyperframes-project-signature",
          )
        ),
    );
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      elements.push(child);
      visit(child);
    }
  };
  visit(document);
  const groups = elements.filter(
    (element) =>
      element.tagName === "hf-audio-group" &&
      element.attrs.some((attr) => attr.name === "data-cutroom-track"),
  );
  const gains = groups.map((element) => {
    const attrs = new Map(element.attrs.map((attr) => [attr.name, attr.value]));
    return {
      id: attrs.get("id") ?? "",
      volume: Number(attrs.get("data-volume") ?? 1),
    };
  });
  const ids = new Set(gains.map((gain) => gain.id));
  for (const group of groups)
    group.attrs = group.attrs.filter(
      (attr) =>
        !["data-volume", "data-hf-id", "data-hf-render-id"].includes(attr.name),
    );
  for (const element of elements)
    if (
      element.attrs.some(
        (attr) => attr.name === "data-audio-group" && ids.has(attr.value),
      )
    )
      element.attrs = element.attrs.filter(
        (attr) => attr.name !== "data-hf-group-render-id",
      );
  for (const element of elements)
    element.attrs.sort((a, b) => a.name.localeCompare(b.name));
  return TrackGainPreviewSchema.parse({
    compositions: [
      ...new Set(
        [
          composition,
          ...elements.flatMap((element) =>
            element.attrs
              .filter((attr) => attr.name === "data-composition-file")
              .map((attr) => attr.value),
          ),
        ].map((path) => posix.normalize(path.replaceAll("\\", "/"))),
      ),
    ],
    signature: fileContentVersion(serialize(document)).slice(1, -1),
    gains,
  });
}
