/**
 * Exit codes, the same for every command (docs: /docs/cli#exit-codes). `briq exec` exits with
 * the command's own code instead.
 */
export const EXIT = {
  ok: 0,
  /** The API refused the call or could not be reached. */
  error: 1,
  /** A wrong command, flag or argument. */
  usage: 2,
  /** Not signed in, or the credential was refused (revoked, expired). */
  auth: 3,
  /** Ctrl-C while waiting (`briq login`). */
  interrupted: 130,
} as const;

/** An error the CLI explains itself, with the exit code it ends on. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.error,
  ) {
    super(message);
  }
}

export const usage = (message: string) => new CliError(message, EXIT.usage);
export const notSignedIn = (message: string) => new CliError(message, EXIT.auth);
