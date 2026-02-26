/**
 * GitHub Webhook Channel for NanoClaw
 *
 * Receives GitHub org webhooks (issues, issue_comment) and injects wake
 * messages into NanoClaw's message pipeline. Also provides a Bearer-auth
 * `/hooks/agent` endpoint for backwards compatibility with dispatch.yml.
 *
 * Agent output goes through `gh` CLI inside the container, so sendMessage
 * is intentionally a no-op.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import crypto from 'crypto';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage } from '../types.js';

const envSecrets = readEnvFile([
  'GITHUB_WEBHOOK_SECRET',
  'API_KEY',
  'GITHUB_WEBHOOK_PORT',
  'GITHUB_BOT_LOGIN',
]);

const WEBHOOK_SECRET =
  process.env.GITHUB_WEBHOOK_SECRET || envSecrets.GITHUB_WEBHOOK_SECRET || '';
const API_KEY = process.env.API_KEY || envSecrets.API_KEY || '';
const PORT = parseInt(
  process.env.GITHUB_WEBHOOK_PORT || envSecrets.GITHUB_WEBHOOK_PORT || '18789',
  10,
);
const BOT_LOGIN =
  process.env.GITHUB_BOT_LOGIN || envSecrets.GITHUB_BOT_LOGIN || 'vlad-nsfox';

/** Virtual JID — all GitHub webhook messages land here */
export const GITHUB_JID = 'github@webhook';

export interface GitHubWebhookChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class GitHubWebhookChannel implements Channel {
  name = 'github-webhook';

  private server: Server | null = null;
  private opts: GitHubWebhookChannelOpts;
  private _connected = false;

  constructor(opts: GitHubWebhookChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (!WEBHOOK_SECRET && !API_KEY) {
      logger.info(
        'GitHub webhook: no GITHUB_WEBHOOK_SECRET or API_KEY set, channel disabled',
      );
      return;
    }

    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          logger.error({ err }, 'Unhandled error in webhook handler');
          if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal error');
          }
        });
      });

      this.server.listen(PORT, () => {
        this._connected = true;
        logger.info({ port: PORT, botLogin: BOT_LOGIN }, 'GitHub webhook channel listening');
        resolve();
      });
    });
  }

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    return jid === GITHUB_JID;
  }

  /** No-op — agent posts comments via gh CLI inside the container */
  async sendMessage(_jid: string, _text: string): Promise<void> {}

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.close();
      this._connected = false;
    }
  }

  // --- Request routing ---

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/hooks/github') {
      await this.handleGitHubWebhook(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/hooks/agent') {
      await this.handleAgentHook(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  // --- GitHub webhook ---

  private async handleGitHubWebhook(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    if (!signature || !verifySignature(body, signature)) {
      logger.warn('GitHub webhook: invalid or missing signature');
      res.writeHead(401);
      res.end('Invalid signature');
      return;
    }

    const event = req.headers['x-github-event'] as string;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString());
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    const wakeText = parseGitHubEvent(event, payload);
    if (!wakeText) {
      res.writeHead(200);
      res.end('Ignored');
      return;
    }

    this.injectMessage(wakeText, 'GitHub');
    logger.info({ event, action: (payload as any).action }, 'GitHub webhook accepted');

    res.writeHead(200);
    res.end('OK');
  }

  // --- dispatch.yml compatibility ---

  private async handleAgentHook(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const auth = req.headers['authorization'];
    if (!API_KEY || auth !== `Bearer ${API_KEY}`) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    const body = await readBody(req);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString());
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    if (typeof payload.message === 'string' && payload.message) {
      this.injectMessage(
        payload.message,
        typeof payload.name === 'string' ? payload.name : 'API',
      );
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  // --- Message injection ---

  private injectMessage(text: string, senderName: string): void {
    const msg: NewMessage = {
      id: `gh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      chat_jid: GITHUB_JID,
      sender: 'github',
      sender_name: senderName,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: false,
    };

    // Chat metadata must be stored before messages (FK constraint on chat_jid)
    this.opts.onChatMetadata(
      GITHUB_JID,
      msg.timestamp,
      'GitHub Webhook',
      'github-webhook',
      false,
    );
    this.opts.onMessage(GITHUB_JID, msg);

    logger.info({ messageId: msg.id, senderName }, 'Webhook message injected');
  }
}

// --- Helpers ---

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(body: Buffer, signature: string): boolean {
  if (!WEBHOOK_SECRET) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

/**
 * Parse a GitHub webhook event into a wake message string.
 * Returns null if the event should be ignored (wrong assignee, anti-loop, etc.)
 */
function parseGitHubEvent(
  event: string,
  payload: Record<string, unknown>,
): string | null {
  const sender = (payload.sender as any)?.login as string | undefined;
  const issue = payload.issue as Record<string, unknown> | undefined;
  if (!issue) return null;

  const assignees: string[] = ((issue.assignees as any[]) || []).map(
    (a) => a.login,
  );
  const repo = (payload.repository as any)?.full_name as string;
  const issueNumber = issue.number as number;
  const issueTitle = issue.title as string;
  const issueUrl = issue.html_url as string;
  const issueBody = ((issue.body as string) || '').slice(0, 2000);
  const labels: string = ((issue.labels as any[]) || [])
    .map((l) => l.name)
    .join(',');

  if (event === 'issues' && (payload as any).action === 'assigned') {
    if (!assignees.includes(BOT_LOGIN)) return null;

    return [
      `Issue #${issueNumber} assigned to you`,
      `Repo: ${repo}`,
      `Issue: #${issueNumber} ${issueTitle}`,
      issueUrl,
      `Labels: ${labels}`,
      `Assignees: ${assignees.join(',')}`,
      '',
      'Description:',
      issueBody,
    ].join('\n');
  }

  if (event === 'issue_comment' && (payload as any).action === 'created') {
    const commentBody: string = (payload as any).comment?.body || '';

    // Anti-loop: skip comments posted by our own bot
    if (sender === BOT_LOGIN) return null;

    // Only wake when explicitly @-mentioned
    if (!commentBody.includes(`@${BOT_LOGIN}`)) return null;

    return [
      `New comment by ${sender} on issue #${issueNumber}`,
      `Repo: ${repo}`,
      `Issue: #${issueNumber} ${issueTitle}`,
      issueUrl,
      `Labels: ${labels}`,
      `Assignees: ${assignees.join(',')}`,
      '',
      'Description:',
      issueBody,
      '',
      'Comment:',
      commentBody,
    ].join('\n');
  }

  return null;
}
