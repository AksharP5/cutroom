export type TimelineErrorCode =
  | "not_found"
  | "locked"
  | "overlap"
  | "out_of_bounds"
  | "nothing_to_split"
  | "duplicate_id"
  | "track_kind"
  | "unsupported";

export class TimelineError extends Error {
  constructor(
    readonly code: TimelineErrorCode,
    message: string,
    /** Index of the failing command within its batch. */
    readonly command?: number,
  ) {
    super(message);
    this.name = "TimelineError";
  }
}
