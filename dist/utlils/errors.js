export class HttpError extends Error {
    constructor(message, statusCode = 500, detail) {
        super(message);
        this.name = "HttpError";
        this.statusCode = statusCode;
        this.detail = detail;
        Object.setPrototypeOf(this, HttpError.prototype);
    }
}
export const NotFound = (message = "Not found", detail) => new HttpError(message, 404, detail);
export const Forbidden = (message = "Forbidden", detail) => new HttpError(message, 403, detail);
export const BadRequest = (message, detail) => new HttpError(message, 400, detail);
export const Conflict = (message, detail) => new HttpError(message, 409, detail);
export const Unauthorized = (message = "Unauthorized", detail) => new HttpError(message, 401, detail);
