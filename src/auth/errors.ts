export type AuthErrorCode = "invalid_request" | "invalid_token" | "insufficient_scope";

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    public readonly code: AuthErrorCode,
    /** Safe, generic description. Never includes token contents. */
    public readonly description: string,
  ) {
    super(description);
    this.name = "AuthError";
  }
}
