export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public isOperational = true,
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * A problem with a file the caller pointed us at. `reason` lets the MCP layer
 * map it to a spec code without matching on the message text.
 */
export class MediaSourceError extends AppError {
  /**
   * `retryable` is false when repeating the same call can never work (a blocked or malformed address, a 404); undefined =
   * the code's default. `hint` overrides the generic next step when the cause is known (the source's HTTP status).
   */
  constructor(statusCode: number, message: string, public readonly reason: 'source_unreachable' | 'unsupported_type' | 'file_too_large', public readonly retryable?: boolean, public readonly hint?: string) {
    super(statusCode, message);
    Object.setPrototypeOf(this, MediaSourceError.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, `${resource} not found`);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message);
  }
}
