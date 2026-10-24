// The Source interface every task source adapter implements, and the event
// envelope the server records everything in.

import type { TaskRef } from "./wire.ts";

export type TaskStatus = "open" | "done" | "failed";

export interface Task {
  ref: TaskRef;
  status: TaskStatus;
  body: string;
  /** Source-specific attributes (labels, front matter, …) a playbook may read. */
  fields: Record<string, string>;
}

export interface TaskUpdate {
  status: TaskStatus;
  /** Written back to the task, for example the session's final summary. */
  note?: string;
}

export interface Source {
  readonly name: string;
  /** Every task the source knows, in any status. */
  list(): Promise<Task[]>;
  /** Calls `onChange` when tasks may have changed; returns a function that stops watching. */
  watch(onChange: () => void): () => void;
  update(id: string, update: TaskUpdate): Promise<void>;
}

export interface Actor {
  kind: "human" | "agent" | "connector" | "system";
  id: string;
}

export interface Envelope<T = unknown> {
  /** Monotonic within one server. */
  id: number;
  /** ISO time. */
  at: string;
  actor: Actor;
  subject?: { task?: string; dispatch?: string; session?: string; approval?: string; connector?: string };
  type: string;
  data: T;
}
