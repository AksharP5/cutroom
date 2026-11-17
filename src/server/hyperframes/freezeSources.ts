import { scanHtmlOpeningTags } from "@hyperframes/parsers";

export const freezeExportSource = "data-cutroom-freeze-export";

/** Substitute the export-colour still before the planner or compiler resolves asset paths. */
export function useFreezeExportSources(html: string) {
  if (!html.includes(freezeExportSource)) return html;
  const edits = scanHtmlOpeningTags(html).flatMap((tag) => {
    if (tag.name !== "img") return [];
    const preview = tag.attributes.find(({ name }) => name === "src");
    const exported = tag.attributes.find(
      ({ name }) => name === freezeExportSource,
    );
    if (!preview || exported?.kind !== "value") return [];
    const value = html.slice(exported.valueStart, exported.valueEnd);
    return [
      {
        start: preview.start,
        end: preview.end,
        text: `src=${exported.quote}${value}${exported.quote}`,
      },
      { start: exported.start, end: exported.end, text: "" },
    ];
  });
  let output = "";
  let cursor = 0;
  for (const { start, end, text } of edits.sort((a, b) => a.start - b.start)) {
    output += html.slice(cursor, start) + text;
    cursor = end;
  }
  return output + html.slice(cursor);
}
