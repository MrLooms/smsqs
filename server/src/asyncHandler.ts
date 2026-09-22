import { Request, Response, NextFunction, RequestHandler } from "express";

// Every route handler and piece of auth middleware in this app now awaits at
// least one Postgres query. Express 4 (unlike 5) does NOT forward a rejected
// promise from an async handler to the error middleware on its own - without
// this wrapper, a dropped DB connection would hang the request instead of
// producing a clean 500 (see index.ts's error-handling middleware, the other
// half of this).
// Generic over the request type so callers can pass AuthedRequest-typed
// handlers (req.userId/req.role, set by requireAuth) without a variance
// error - the cast is safe because Express hands every handler the same
// real request object regardless of which type it's annotated with here.
export function ah<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<any>
): RequestHandler {
  return (req, res, next) => {
    fn(req as Req, res, next).catch(next);
  };
}
