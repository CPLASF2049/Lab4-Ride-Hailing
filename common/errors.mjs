// Pure shared error value. No HTTP server, database, or authentication dependency.
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
