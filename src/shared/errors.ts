export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 502 | 503;

  constructor(status: HttpError["status"], message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}
