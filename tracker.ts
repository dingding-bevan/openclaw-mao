import { openDb, migrate, type SqliteHandle } from "./sqlite-resilience.ts";

export type TaskType = "bugfix" | "feature" | "refactor" | "plan-doc" | "review";
export type Priority = "low" | "medium" | "high";
export type SubStatus =
  | "blocked"
  | "pending"
  | "dispatch"
  | "running"
  | "verifying"
  | "pushed"
  | "reviewing"
  | "awaiting_clarification"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskRow {
  task_id: string;
  type: TaskType;
  priority: Priority;
  description: string;
  assignee: string;
  branch: string | null;
  worktree_path: string | null;
  sub_status: SubStatus;
  openclaw_task_id: string | null;
  openclaw_parent_task_id: string | null;
  plan_doc: string | null;
  review_required: 0 | 1;
  retry_run: number;
  retry_review: number;
  result_json: string | null;
  error: string | null;
  review_verdict: "pass" | "fail" | "needs-clarification" | null;
  review_feedback: string | null;
  reviewed_at: string | null;
  clarify_question: string | null;
  created_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
}

const SCHEMA = [
  `CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    description TEXT NOT NULL,
    assignee TEXT NOT NULL,
    branch TEXT,
    worktree_path TEXT,
    sub_status TEXT NOT NULL DEFAULT 'pending',
    openclaw_task_id TEXT,
    openclaw_parent_task_id TEXT,
    plan_doc TEXT,
    review_required INTEGER NOT NULL DEFAULT 0,
    retry_run INTEGER NOT NULL DEFAULT 0,
    retry_review INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    dispatched_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX idx_tasks_sub_status ON tasks (sub_status);
  CREATE INDEX idx_tasks_assignee ON tasks (assignee);
  CREATE INDEX idx_tasks_parent ON tasks (openclaw_parent_task_id);`,

  // v2: Phase 3 review fields
  `ALTER TABLE tasks ADD COLUMN review_verdict TEXT;
   ALTER TABLE tasks ADD COLUMN review_feedback TEXT;
   ALTER TABLE tasks ADD COLUMN reviewed_at TEXT;`,

  // v3: Phase 3.5 awaiting_clarification flow
  `ALTER TABLE tasks ADD COLUMN clarify_question TEXT;`,
];

let handle: SqliteHandle | null = null;

export const Tracker = {
  init(path: string): void {
    handle = openDb(path);
    migrate(handle, SCHEMA);
  },

  isReady(): boolean {
    return handle !== null;
  },

  insert(row: Omit<TaskRow, "created_at" | "sub_status" | "retry_run" | "retry_review" | "review_required"> & {
    review_required?: boolean;
    sub_status?: SubStatus;
  }): TaskRow {
    if (!handle) throw new Error("Tracker not initialized");
    const created_at = new Date().toISOString();
    const full: TaskRow = {
      ...row,
      sub_status: row.sub_status ?? "pending",
      review_required: row.review_required ? 1 : 0,
      retry_run: 0,
      retry_review: 0,
      created_at,
    };
    handle.db
      .prepare(
        `INSERT INTO tasks (
          task_id, type, priority, description, assignee, branch, worktree_path,
          sub_status, openclaw_task_id, openclaw_parent_task_id, plan_doc,
          review_required, retry_run, retry_review, result_json, error,
          review_verdict, review_feedback, reviewed_at, clarify_question,
          created_at, dispatched_at, completed_at
        ) VALUES (
          @task_id, @type, @priority, @description, @assignee, @branch, @worktree_path,
          @sub_status, @openclaw_task_id, @openclaw_parent_task_id, @plan_doc,
          @review_required, @retry_run, @retry_review, @result_json, @error,
          @review_verdict, @review_feedback, @reviewed_at, @clarify_question,
          @created_at, @dispatched_at, @completed_at
        )`,
      )
      .run({ ...full, review_verdict: null, review_feedback: null, reviewed_at: null, clarify_question: null });
    return full;
  },

  get(taskId: string): TaskRow | null {
    if (!handle) throw new Error("Tracker not initialized");
    return (
      (handle.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined) ??
      null
    );
  },

  list(filter?: { sub_status?: SubStatus; assignee?: string; type?: TaskType }): TaskRow[] {
    if (!handle) throw new Error("Tracker not initialized");
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter?.sub_status) {
      clauses.push("sub_status = @sub_status");
      params.sub_status = filter.sub_status;
    }
    if (filter?.assignee) {
      clauses.push("assignee = @assignee");
      params.assignee = filter.assignee;
    }
    if (filter?.type) {
      clauses.push("type = @type");
      params.type = filter.type;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return handle.db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`).all(params) as TaskRow[];
  },

  update(taskId: string, patch: Partial<TaskRow>): void {
    if (!handle) throw new Error("Tracker not initialized");
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    handle.db.prepare(`UPDATE tasks SET ${sets} WHERE task_id = @task_id`).run({ ...patch, task_id: taskId });
  },

  countActive(): number {
    if (!handle) throw new Error("Tracker not initialized");
    const row = handle.db
      .prepare(
        "SELECT COUNT(*) AS c FROM tasks WHERE sub_status IN ('pending','dispatch','running','verifying','pushed','reviewing','awaiting_clarification')",
      )
      .get() as { c: number };
    return row.c;
  },
};
