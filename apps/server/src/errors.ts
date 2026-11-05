import type { FastifyInstance } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import type { ErrorResponse } from '@sflow/domain';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(code: string, message: string, details?: unknown): ErrorResponse {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

export function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Request validation failed.',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return parsed.data;
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send(errorResponse(error.code, error.message, error.details));
      return;
    }

    if (error instanceof ZodError) {
      reply.code(400).send(
        errorResponse(
          'VALIDATION_ERROR',
          'Request validation failed.',
          error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        ),
      );
      return;
    }

    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;

    if (statusCode >= 400 && statusCode < 500) {
      const message = error instanceof Error ? error.message : 'The request could not be processed.';
      reply.code(statusCode).send(
        errorResponse(statusCode === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', message),
      );
      return;
    }

    request.log.error({ err: error }, 'Unhandled request error');
    reply.code(500).send(errorResponse('INTERNAL_ERROR', 'An internal error occurred.'));
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, 'http://sflow.local').pathname;
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      reply.code(404).send(errorResponse('NOT_FOUND', 'The requested API route does not exist.'));
      return;
    }

    reply
      .code(404)
      .type('text/html; charset=utf-8')
      .send(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SFlow</title></head><body><h1>SFlow</h1><p>Page not found.</p></body></html>',
      );
  });
}
