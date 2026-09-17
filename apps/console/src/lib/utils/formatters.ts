/**
 * Formats an ISO date string or Date object into a relative time description (e.g. 'just now', '5m ago', '2h ago').
 */
export function formatRelativeTime(dateInput: string | Date | number): string {
  const date = typeof dateInput === "string" || typeof dateInput === "number" ? new Date(dateInput) : dateInput;
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 10) return "just now";
  if (diffInSeconds < 60) return `${diffInSeconds.toString()}s ago`;

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes.toString()}m ago`;

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours.toString()}h ago`;

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays === 1) return "yesterday";
  if (diffInDays < 30) return `${diffInDays.toString()}d ago`;

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Truncates a string to a max length with an ellipsis.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}
