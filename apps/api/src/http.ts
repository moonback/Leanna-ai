/** `expose`: the message is written for the client (even for a 503). */
export type HttpError = Error & { statusCode: number; expose: true };

export function httpError(statusCode: number, message: string): HttpError {
  return Object.assign(new Error(message), { statusCode, expose: true as const });
}
