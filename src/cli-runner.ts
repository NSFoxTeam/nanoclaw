/**
 * CLI Runner for NanoClaw
 * Spawns Claude Code CLI agents and handles session management.
 * Fire-and-forget: stdout/stderr → debug log, exit code = result.
 */
import { ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  AGENT_TIMEOUT,
  ASSISTANT_NAME,
  CLI_BINARY,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface CliInput {
  prompt: string;
  sessionId?: string; // undefined = new session, string = resume
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface CliOutput {
  status: 'success' | 'error';
  error?: string;
  sessionId: string; // UUID (generated or passed through)
}

// Track active PIDs for shutdown cleanup
const activePids = new Set<number>();

const ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
].join(',');

/**
 * Run a Claude CLI agent for the given group.
 * Fire-and-forget: agent communicates via MCP tools, not stdout.
 */
export async function runCliAgent(
  group: RegisteredGroup,
  input: CliInput,
  onProcess: (proc: ChildProcess) => void,
): Promise<CliOutput> {
  const startTime = Date.now();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Session management: new UUID or resume existing
  const sessionId = input.sessionId || crypto.randomUUID();
  const isResume = !!input.sessionId;

  // Prepare per-group environment (settings, skills, MCP, IPC dirs)
  prepareGroupEnvironment(group, input);

  // Build CLI arguments and env
  const args = buildCliArgs(input, sessionId, isResume, groupDir);
  const env = buildEnv();

  logger.info(
    {
      group: group.name,
      sessionId,
      isResume,
      isMain: input.isMain,
    },
    'Spawning CLI agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn(CLI_BINARY, args, {
      cwd: groupDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    if (proc.pid) activePids.add(proc.pid);
    onProcess(proc);

    // stdout/stderr → debug log (not business logic)
    proc.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim()) logger.debug({ agent: group.folder }, line);
      }
    });

    proc.stderr.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim()) logger.debug({ agent: group.folder }, line);
      }
    });

    // Timeout: SIGTERM → 15s → SIGKILL
    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || AGENT_TIMEOUT;

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, sessionId },
        'Agent timeout, sending SIGTERM',
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) {
          logger.warn({ group: group.name }, 'Graceful stop failed, SIGKILL');
          proc.kill('SIGKILL');
        }
      }, 15000);
    };

    const timeout = setTimeout(killOnTimeout, configTimeout);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (proc.pid) activePids.delete(proc.pid);
      const duration = Date.now() - startTime;

      // Write run log
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${ts}.log`);
      fs.writeFileSync(
        logFile,
        [
          `=== Agent Run Log ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Session: ${sessionId} (${isResume ? 'resume' : 'new'})`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Timed Out: ${timedOut}`,
        ].join('\n'),
      );

      if (timedOut) {
        resolve({
          status: 'error',
          error: `Agent timed out after ${configTimeout}ms`,
          sessionId,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration },
          'Agent exited with error',
        );
        resolve({
          status: 'error',
          error: `Agent exited with code ${code}`,
          sessionId,
        });
        return;
      }

      logger.info(
        { group: group.name, duration, sessionId },
        'Agent completed',
      );
      resolve({ status: 'success', sessionId });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if (proc.pid) activePids.delete(proc.pid);
      logger.error(
        { group: group.name, error: err },
        'Agent spawn error',
      );
      resolve({
        status: 'error',
        error: `Spawn error: ${err.message}`,
        sessionId,
      });
    });
  });
}

/** Get active PIDs for shutdown handling. */
export function getActivePids(): ReadonlySet<number> {
  return activePids;
}

// --- Internal helpers ---

function prepareGroupEnvironment(
  group: RegisteredGroup,
  input: CliInput,
): void {
  const groupDir = resolveGroupFolderPath(group.folder);
  const projectRoot = process.cwd();

  // Per-group .claude directory (project-level settings for Claude Code)
  const claudeDir = path.join(groupDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  // Write settings.json (hooks + env config)
  writeSettings(claudeDir, projectRoot);

  // Sync skills from skills/ into per-group .claude/skills/
  syncSkills(claudeDir, projectRoot);

  // Prepare IPC directories
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });

  // Write MCP config (per-group, atomic)
  writeMcpConfig(claudeDir, groupIpcDir, input);
}

function writeSettings(claudeDir: string, projectRoot: string): void {
  const preCompactPath = path.join(projectRoot, 'hooks', 'pre-compact.js');
  const sanitizeBashPath = path.join(
    projectRoot,
    'hooks',
    'sanitize-bash.js',
  );

  const settings = {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
    hooks: {
      PreCompact: [
        {
          hooks: [
            { type: 'command', command: `node ${preCompactPath}` },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: `node ${sanitizeBashPath}` },
          ],
        },
      ],
    },
  };

  const settingsPath = path.join(claudeDir, 'settings.json');
  const tmpPath = `${settingsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmpPath, settingsPath);
}

function syncSkills(claudeDir: string, projectRoot: string): void {
  const skillsSrc = path.join(projectRoot, 'skills');
  if (!fs.existsSync(skillsSrc)) return;

  const skillsDst = path.join(claudeDir, 'skills');
  for (const entry of fs.readdirSync(skillsSrc)) {
    const srcDir = path.join(skillsSrc, entry);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const dstDir = path.join(skillsDst, entry);
    fs.cpSync(srcDir, dstDir, { recursive: true });
  }
}

function writeMcpConfig(
  claudeDir: string,
  groupIpcDir: string,
  input: CliInput,
): void {
  const projectRoot = process.cwd();
  const mcpServerPath = path.join(
    projectRoot,
    'dist',
    'mcp',
    'ipc-mcp-stdio.js',
  );

  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_IPC_DIR: groupIpcDir,
          NANOCLAW_CHAT_JID: input.chatJid,
          NANOCLAW_GROUP_FOLDER: input.groupFolder,
          NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
        },
      },
    },
  };

  const configPath = path.join(claudeDir, 'mcp-config.json');
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmpPath, configPath);
}

function buildCliArgs(
  input: CliInput,
  sessionId: string,
  isResume: boolean,
  groupDir: string,
): string[] {
  const mcpConfigPath = path.join(groupDir, '.claude', 'mcp-config.json');

  // Build prompt with optional scheduled task prefix
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  const args: string[] = [
    '-p',
    prompt,
    '--dangerously-skip-permissions',
    '--model',
    'claude-opus-4-6',
    '--mcp-config',
    mcpConfigPath,
    '--allowedTools',
    ALLOWED_TOOLS,
  ];

  if (isResume) {
    args.push('--resume', sessionId);
  } else {
    args.push('--session-id', sessionId);
  }

  // For non-main groups, append global CLAUDE.md as additional system prompt
  if (!input.isMain) {
    const globalClaudeMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    if (fs.existsSync(globalClaudeMd)) {
      const content = fs.readFileSync(globalClaudeMd, 'utf-8');
      if (content.trim()) {
        args.push('--append-system-prompt', content);
      }
    }
  }

  return args;
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TZ: TIMEZONE,
    NANOCLAW_ASSISTANT_NAME: ASSISTANT_NAME,
  };

  // Load secrets from .env — only for the CLI process, not leaked to subprocesses
  // (the sanitize-bash hook strips them from Bash tool commands)
  const secrets = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'GH_TOKEN',
  ]);
  for (const [key, value] of Object.entries(secrets)) {
    env[key] = value;
  }

  return env;
}
