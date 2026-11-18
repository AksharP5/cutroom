export function chatClock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

export function chatAge(updatedAt: string, now: number) {
  const date = Date.parse(updatedAt);
  const minutes = Math.floor((now - date) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 7 * 1440) return `${Math.floor(minutes / 1440)}d`;
  return shortDate.format(date);
}
