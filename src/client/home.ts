import type { Project, ProjectSummary } from "../shared/project";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2 h ago" through the first week, then the date, with its year once that differs. */
export function editedLabel(edited: string, now: number): string {
  const time = Date.parse(edited);
  const age = now - time;
  if (age < MINUTE) return "Just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)} d ago`;
  const date = new Date(time);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date(now).getFullYear() && {
      year: "numeric",
    }),
  });
}

/** `0:12`, `21:05`, `1:02:34`: whole seconds, hours only when there are any. */
export function durationLabel(seconds: number): string {
  const total = Math.round(seconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours
    ? `${hours}:${pad(minutes)}:${pad(total % 60)}`
    : `${minutes}:${pad(total % 60)}`;
}

/** `16:9` when the ratio reduces to small terms, otherwise `2.39:1` or `1:2.39`. */
export function aspectLabel(width: number, height: number): string {
  const divisor = (a: number, b: number): number => (b ? divisor(b, a % b) : a);
  const [w, h] = [Math.round(width), Math.round(height)];
  const shared = divisor(w, h);
  if (Math.max(w, h) / shared <= 32) return `${w / shared}:${h / shared}`;
  return w >= h ? `${(w / h).toFixed(2)}:1` : `1:${(h / w).toFixed(2)}`;
}

/**
 * The frame one second in, or halfway through a shorter project, from the server's cached frame
 * capture. `edited` only makes the browser ask again after an edit; the server keys its cache on
 * the project's content.
 */
export function posterUrl(
  project: Pick<Project, "id" | "updatedAt">,
  { duration }: Pick<ProjectSummary, "duration">,
): string {
  const params = new URLSearchParams({
    t: Math.min(1, duration / 2).toFixed(2),
    format: "jpeg",
    output: "source",
    edited: project.updatedAt,
  });
  return `/api/projects/${encodeURIComponent(project.id)}/thumbnail/index.html?${params}`;
}

/** Where an arrow, Home or End key moves focus in a grid of `count` tiles; null when it stays. */
export function gridStep(
  key: string,
  index: number,
  columns: number,
  count: number,
): number | null {
  switch (key) {
    case "ArrowLeft":
      return index > 0 ? index - 1 : null;
    case "ArrowRight":
      return index < count - 1 ? index + 1 : null;
    case "ArrowUp":
      return index >= columns ? index - columns : null;
    case "ArrowDown": {
      if (index + columns < count) return index + columns;
      // A short last row stays reachable from the columns it does not fill.
      const lastRow = Math.floor((count - 1) / columns);
      return Math.floor(index / columns) < lastRow ? count - 1 : null;
    }
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
