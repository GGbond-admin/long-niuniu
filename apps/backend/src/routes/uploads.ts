import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat, unlink } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config.js';

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};
const PROOF_FILENAME = /^[0-9a-f-]{36}\.(?:jpg|png|webp|pdf)$/;
const RESPONSE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

async function matchesDeclaredType(path: string, mimetype: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (mimetype === 'image/jpeg') {
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (mimetype === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    if (mimetype === 'image/webp') {
      return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    }
    if (mimetype === 'application/pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
    return false;
  } finally {
    await handle.close();
  }
}

export async function uploadRoutes(app: FastifyInstance) {
  app.post(
    '/api/uploads/proof',
    {
      preHandler: [app.authUser, app.requireKyc],
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (req, reply) => {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'FILE_REQUIRED' });
      const extension = ALLOWED_TYPES[file.mimetype];
      if (!extension) {
        file.file.resume();
        return reply.code(400).send({ error: 'UNSUPPORTED_FILE_TYPE' });
      }
      const filename = `${randomUUID()}${extension}`;
      const destination = resolve(env.uploadDir, filename);
      try {
        await pipeline(file.file, createWriteStream(destination, { flags: 'wx' }));
        if (file.file.truncated) {
          await unlink(destination).catch(() => undefined);
          return reply.code(413).send({ error: 'FILE_TOO_LARGE' });
        }
        if (!(await matchesDeclaredType(destination, file.mimetype))) {
          await unlink(destination).catch(() => undefined);
          return reply.code(400).send({ error: 'FILE_CONTENT_MISMATCH' });
        }
      } catch (error) {
        await unlink(destination).catch(() => undefined);
        throw error;
      }
      return { url: `upload://${filename}` };
    },
  );

  app.get(
    '/api/admin/uploads/:filename',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE')] },
    async (req, reply) => {
      const { filename } = z
        .object({ filename: z.string().regex(PROOF_FILENAME) })
        .parse(req.params);
      const path = resolve(env.uploadDir, filename);
      try {
        const metadata = await stat(path);
        if (!metadata.isFile()) throw new Error('NOT_FILE');
      } catch {
        return reply.code(404).send({ error: 'UPLOAD_NOT_FOUND' });
      }
      reply
        .type(RESPONSE_TYPES[extname(filename)] ?? 'application/octet-stream')
        .header('Content-Disposition', `inline; filename="${filename}"`)
        .header('Cache-Control', 'private, no-store');
      return reply.send(createReadStream(path));
    },
  );
}
