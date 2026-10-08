import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ZodError } from 'zod';

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as jwt.JwtPayload;
    if (!payload.sub) return res.status(401).json({ error: 'Invalid session' });
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

export function errors(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) return res.status(400).json({ error: 'Validation failed', details: error.flatten().fieldErrors });
  console.error(error);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

export function parse<T>(schema: { parse: (input: unknown) => T }, input: unknown): T {
  return schema.parse(input);
}
