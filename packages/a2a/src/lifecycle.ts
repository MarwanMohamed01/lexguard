import type { Message, Task, TaskState } from "./schema";

// JSON-RPC error codes defined by the A2A specification v1.0.
export const A2A_ERROR_CODES = {
  TaskNotFoundError: -32001,
  TaskNotCancelableError: -32002,
  PushNotificationNotSupportedError: -32003,
  UnsupportedOperationError: -32004,
  ContentTypeNotSupportedError: -32005,
  InvalidAgentResponseError: -32006,
  ExtendedAgentCardNotConfiguredError: -32007,
  ExtensionSupportRequiredError: -32008,
  VersionNotSupportedError: -32009,
} as const;

export type A2AErrorName = keyof typeof A2A_ERROR_CODES;

export class A2AError extends Error {
  readonly code: number;

  constructor(
    readonly errorName: A2AErrorName,
    message: string,
  ) {
    super(message);
    this.name = errorName;
    this.code = A2A_ERROR_CODES[errorName];
  }
}

// The spec fixes the terminal states; it does not define a full transition graph. This table
// is Lexguard's choice, consistent with the spec: nothing leaves a terminal state.
const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  TASK_STATE_SUBMITTED: [
    "TASK_STATE_WORKING",
    "TASK_STATE_AUTH_REQUIRED",
    "TASK_STATE_REJECTED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
  ],
  TASK_STATE_WORKING: [
    "TASK_STATE_INPUT_REQUIRED",
    "TASK_STATE_AUTH_REQUIRED",
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
  ],
  TASK_STATE_INPUT_REQUIRED: ["TASK_STATE_WORKING", "TASK_STATE_FAILED", "TASK_STATE_CANCELED"],
  TASK_STATE_AUTH_REQUIRED: [
    "TASK_STATE_WORKING",
    "TASK_STATE_REJECTED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
  ],
  TASK_STATE_COMPLETED: [],
  TASK_STATE_FAILED: [],
  TASK_STATE_CANCELED: [],
  TASK_STATE_REJECTED: [],
};

export const TERMINAL_STATES: readonly TaskState[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
];

export const isTerminal = (state: TaskState): boolean => TERMINAL_STATES.includes(state);

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

// Returns a new task in the next state; the input task is never modified.
export function transition(task: Task, to: TaskState, now: Date, message?: Message): Task {
  const from = task.status.state;
  if (!canTransition(from, to)) {
    throw new A2AError(
      "UnsupportedOperationError",
      isTerminal(from)
        ? `task ${task.id} is in terminal state ${from}`
        : `task ${task.id} cannot move from ${from} to ${to}`,
    );
  }
  const status =
    message === undefined
      ? { state: to, timestamp: now.toISOString() }
      : { state: to, timestamp: now.toISOString(), message };
  return { ...task, status };
}

// CancelTask: allowed from any non-terminal state, otherwise TaskNotCancelableError (-32002).
export function cancel(task: Task, now: Date): Task {
  if (isTerminal(task.status.state)) {
    throw new A2AError("TaskNotCancelableError", `task ${task.id} is already ${task.status.state}`);
  }
  return transition(task, "TASK_STATE_CANCELED", now);
}

export function newTask(id: string, now: Date, contextId?: string): Task {
  const status = { state: "TASK_STATE_SUBMITTED" as const, timestamp: now.toISOString() };
  return contextId === undefined ? { id, status } : { id, contextId, status };
}
