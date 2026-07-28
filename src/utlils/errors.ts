export class HttpError extends Error {
  statusCode: number;
  detail?: unknown;

  constructor(message: string, statusCode = 500, detail?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.detail = detail;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

export const NotFound = (message = "Not found", detail?: unknown): HttpError =>
  new HttpError(message, 404, detail);

export const Forbidden = (message = "Forbidden", detail?: unknown): HttpError =>
  new HttpError(message, 403, detail);

export const BadRequest = (message: string, detail?: unknown): HttpError =>
  new HttpError(message, 400, detail);

export const Conflict = (message: string, detail?: unknown): HttpError =>
  new HttpError(message, 409, detail);

export const Unauthorized = (
  message = "Unauthorized",
  detail?: unknown
): HttpError => new HttpError(message, 401, detail);
