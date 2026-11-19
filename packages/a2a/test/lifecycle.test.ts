import { describe, expect, it } from "vitest";
import {
  A2AError,
  cancel,
  canTransition,
  isTerminal,
  newTask,
  TaskState,
  TERMINAL_STATES,
  transition,
  type Task,
} from "../src/index";

const now = new Date("2026-11-19T10:00:00.000Z");
const later = new Date("2026-11-19T10:05:00.000Z");

describe("task lifecycle", () => {
  it("creates a new task in SUBMITTED", () => {
    expect(newTask("t1", now, "ctx")).toEqual({
      id: "t1",
      contextId: "ctx",
      status: { state: "TASK_STATE_SUBMITTED", timestamp: "2026-11-19T10:00:00.000Z" },
    });
  });

  it("follows the happy path submitted → working → completed", () => {
    const working = transition(newTask("t1", now), "TASK_STATE_WORKING", now);
    const done = transition(working, "TASK_STATE_COMPLETED", later);
    expect(done.status).toEqual({
      state: "TASK_STATE_COMPLETED",
      timestamp: "2026-11-19T10:05:00.000Z",
    });
  });

  it("never modifies the input task", () => {
    const task = newTask("t1", now);
    transition(task, "TASK_STATE_WORKING", later);
    expect(task.status.state).toBe("TASK_STATE_SUBMITTED");
  });

  it("allows pausing for input and resuming", () => {
    let task: Task = transition(newTask("t1", now), "TASK_STATE_WORKING", now);
    task = transition(task, "TASK_STATE_INPUT_REQUIRED", now);
    task = transition(task, "TASK_STATE_WORKING", now);
    expect(task.status.state).toBe("TASK_STATE_WORKING");
  });

  it.each(TERMINAL_STATES)("allows nothing out of terminal state %s", (terminal) => {
    expect(isTerminal(terminal)).toBe(true);
    for (const to of TaskState.options) expect(canTransition(terminal, to)).toBe(false);
  });

  it("rejects leaving a terminal state with UnsupportedOperationError (-32004)", () => {
    const done = transition(
      transition(newTask("t1", now), "TASK_STATE_WORKING", now),
      "TASK_STATE_COMPLETED",
      now,
    );
    try {
      transition(done, "TASK_STATE_WORKING", later);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(A2AError);
      expect(error).toMatchObject({ errorName: "UnsupportedOperationError", code: -32004 });
    }
  });

  it.each<[TaskState, TaskState]>([
    ["TASK_STATE_SUBMITTED", "TASK_STATE_COMPLETED"], // must work before completing
    ["TASK_STATE_SUBMITTED", "TASK_STATE_INPUT_REQUIRED"],
    ["TASK_STATE_WORKING", "TASK_STATE_SUBMITTED"],
    ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_COMPLETED"],
  ])("rejects the skip %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("cancels a running task", () => {
    const working = transition(newTask("t1", now), "TASK_STATE_WORKING", now);
    expect(cancel(working, later).status.state).toBe("TASK_STATE_CANCELED");
  });

  it.each(TERMINAL_STATES)(
    "refuses to cancel a %s task with TaskNotCancelableError (-32002)",
    (state) => {
      const task: Task = { id: "t1", status: { state } };
      expect(() => cancel(task, later)).toThrow(expect.objectContaining({ code: -32002 }) as Error);
    },
  );
});
