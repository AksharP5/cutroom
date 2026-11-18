import type { ComponentProps } from "react";
import { quietTimecode } from "../../shared/timeline/timecode";

/**
 * A timecode with quiet zeros: the groups that carry nothing are drawn in `--text-quiet`, so the
 * eye lands on the digits that change. Its text is the full `HH:MM:SS:FF` timecode.
 */
export function TimecodeText({
  timecode,
  trailing,
  ...spanProps
}: ComponentProps<"span"> & {
  timecode: string;
  /** Also quiets a `:00` frames group, as on the ruler. */
  trailing?: boolean;
}) {
  const { lead, value, tail } = quietTimecode(timecode, { trailing });
  return (
    <span {...spanProps}>
      {lead && <span className="timecode-quiet">{lead}</span>}
      {value}
      {tail && <span className="timecode-quiet">{tail}</span>}
    </span>
  );
}
