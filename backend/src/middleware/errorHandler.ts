import { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { logger } from "../services/logger";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  logger.error({ err: String(err), path: req.path }, "unhandled error");
  res.status(500).json({ error: "internal server error" });
};
