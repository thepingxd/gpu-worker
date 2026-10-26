export type ErrorCode =
  | "INVALID_PARAMS"
  | "INSUFFICIENT_VRAM"
  | "JOB_UNAVAILABLE"
  | "INPUT_NOT_FOUND"
  | "INPUT_REJECTED"
  | "QUEUE_FULL"
  | "TIMEOUT"
  | "CANCELLED"
  | "RUNNER_ERROR";

export class WorkerError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
  }
}
