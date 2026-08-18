export interface ErrorEnvelope {
  Message: string;
  ModelState: Record<string, string[]>;
  ValidationErrors: unknown[];
}

export class BitwardenError extends Error {
  readonly status: number;
  readonly modelState?: Record<string, string[]>;
  readonly validationErrors?: unknown[];

  constructor(
    status: number,
    message: string,
    modelState?: Record<string, string[]>,
    validationErrors?: unknown[],
  ) {
    super(message);
    this.status = status;
    this.modelState = modelState;
    this.validationErrors = validationErrors;
  }
}

export function toErrorBody(err: BitwardenError): string {
  const envelope: ErrorEnvelope = {
    Message: err.message,
    ModelState: err.modelState ?? {},
    ValidationErrors: err.validationErrors ?? [],
  };
  return JSON.stringify(envelope);
}

export function notFound(): BitwardenError {
  return new BitwardenError(404, 'Not found.');
}

export function badRequest(message: string): BitwardenError {
  return new BitwardenError(400, message);
}

export function internalError(): BitwardenError {
  return new BitwardenError(500, 'Internal server error.');
}