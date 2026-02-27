#!/usr/bin/env node
/**
 * PreCompact hook: archive transcript before context compaction.
 * Saves a markdown copy of the conversation to {cwd}/conversations/.
 *
 * Stdin:  JSON { session_id, transcript_path, cwd }
 * Stdout: JSON {}
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    archiveTranscript(input);
  } catch (err) {
    log(`Hook error: ${err.message || err}`);
  }
  process.stdout.write('{}');
});

function log(msg) {
  process.stderr.write(`[pre-compact] ${msg}\n`);
}

function archiveTranscript(input) {
  const { transcript_path, session_id, cwd } = input;

  if (!transcript_path || !existsSync(transcript_path)) {
    log('No transcript found for archiving');
    return;
  }

  const content = readFileSync(transcript_path, 'utf-8');
  const messages = parseTranscript(content);
  if (messages.length === 0) {
    log('No messages to archive');
    return;
  }

  const summary = getSessionSummary(session_id, transcript_path);
  const name = summary ? sanitizeFilename(summary) : generateFallbackName();

  const conversationsDir = join(cwd || process.cwd(), 'conversations');
  mkdirSync(conversationsDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}-${name}.md`;
  const filePath = join(conversationsDir, filename);

  const assistantName = process.env.NANOCLAW_ASSISTANT_NAME || 'Assistant';
  const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
  writeFileSync(filePath, markdown);

  log(`Archived conversation to ${filePath}`);
}

function getSessionSummary(sessionId, transcriptPath) {
  const projectDir = dirname(transcriptPath);
  const indexPath = join(projectDir, 'sessions-index.json');

  if (!existsSync(indexPath)) return null;

  try {
    const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
    const entry = index.entries?.find(e => e.sessionId === sessionId);
    return entry?.summary || null;
  } catch {
    return null;
  }
}

function parseTranscript(content) {
  const messages = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map(c => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = entry.message.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch { /* skip malformed lines */ }
  }
  return messages;
}

function formatTranscriptMarkdown(messages, title, assistantName) {
  const now = new Date();
  const formatDateTime = (d) => d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const lines = [
    `# ${title || 'Conversation'}`,
    '',
    `Archived: ${formatDateTime(now)}`,
    '',
    '---',
    '',
  ];

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName;
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function sanitizeFilename(summary) {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName() {
  const t = new Date();
  return `conversation-${t.getHours().toString().padStart(2, '0')}${t.getMinutes().toString().padStart(2, '0')}`;
}
