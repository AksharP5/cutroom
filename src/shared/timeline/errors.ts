export type TimelineErrorCode =
  | "not_found"
  | "locked"
  | "overlap"
  | "out_of_bounds"
  | "nothing_to_split"
  | "duplicate_id"
  | "track_kind"
  | "unsupported";

// Plain fields rather than parameter properties: export's Node worker strips types only.
export class TimelineError extends Error {
  readonly code: TimelineErrorCode;
  /** Index of the failing command within its batch. */
  readonly command?: number;

  constructor(code: TimelineErrorCode, message: string, command?: number) {
    super(message);
    this.name = "TimelineError";
    this.code = code;
    this.command = command;
  }
}
