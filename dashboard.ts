import { Tracker, type TaskRow } from "./tracker.ts";

export interface DashboardOpts {
  showAll?: boolean;
  filterAgent?: string;
  filterType?: string;
}

const ACTIVE: TaskRow["sub_status"][] = [
  "blocked",
  "pending",
  "dispatch",
  "running",
  "awaiting_human_work",
  "verifying",
  "pushed",
  "reviewing",
  "awaiting_clarification",
];

function ageMin(iso: string | null): string {
  if (!iso) return "-";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

function pad(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len - 1) + "…";
  return s + " ".repeat(len - s.length);
}

function shortId(taskId: string): string {
  // task-1778310057710-bpxinw → bpxinw (last segment)
  const parts = taskId.split("-");
  return parts[parts.length - 1];
}

export const Dashboard = {
  render(opts: DashboardOpts): string {
    let rows = Tracker.list();
    if (!opts.showAll) {
      rows = rows.filter((r) => ACTIVE.includes(r.sub_status));
    }
    if (opts.filterAgent) rows = rows.filter((r) => r.assignee === opts.filterAgent);
    if (opts.filterType) rows = rows.filter((r) => r.type === opts.filterType);

    if (rows.length === 0) {
      return opts.showAll ? "(no tasks)" : "(no active tasks)\nUse --all to include completed/failed/cancelled.";
    }

    const header = [
      pad("task", 10),
      pad("type", 9),
      pad("pri", 4),
      pad("mode", 6),
      pad("agent", 14),
      pad("sub_status", 22),
      pad("age", 8),
      pad("retry", 6),
      "branch",
    ].join(" │ ");

    const sep = "─".repeat(header.length + 4);

    const lines: string[] = [];
    lines.push(header);
    lines.push(sep);

    for (const r of rows) {
      lines.push(
        [
          pad(shortId(r.task_id), 10),
          pad(r.type, 9),
          pad(r.priority, 4),
          pad(r.mode ?? "auto", 6),
          pad(r.assignee, 14),
          pad(r.sub_status, 22),
          pad(ageMin(r.dispatched_at ?? r.created_at), 8),
          pad(`${r.retry_run}/${r.retry_review}`, 6),
          r.branch ?? "-",
        ].join(" │ "),
      );
    }
    lines.push(sep);
    lines.push(`${rows.length} task${rows.length === 1 ? "" : "s"} (${opts.showAll ? "all" : "active"})`);
    return lines.join("\n");
  },
};
