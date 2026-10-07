import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';

/** Kernel-held single-owner lease, automatically released even after SIGKILL.
 * Hash collisions fail closed; this listener serves no requests or private data. */
export class RecoveryLease {
  private server?: Server;
  port: number;
  private dir: string;
  constructor(dir: string) { this.dir = path.resolve(dir); this.port = this.portFor(this.dir); }
  private portFor(dir: string): number { return 45000 + (createHash('sha256').update(dir).digest().readUInt32BE(0) % 18000); }
  async acquire(): Promise<void> {
    if (this.server) throw new Error('Recovery lease is already held');
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.port = this.portFor(await fs.realpath(this.dir));
    const server = createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port: this.port, host: '127.0.0.1', exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', () => {}); server.unref(); this.server = server;
  }
  async close(): Promise<void> { const server = this.server; this.server = undefined; if (server) await new Promise<void>(resolve => server.close(() => resolve())); }
}
