/** The API answered with an error status. */
export class BriqApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** The API's id for the failed request (`x-request-id`): quote it when asking for help. */
    readonly requestId?: string,
    /** The answer is a stored one, sent again for a repeated `Idempotency-Key`: sending it again gives the same. */
    readonly replayed = false,
  ) {
    super(message);
  }
}
