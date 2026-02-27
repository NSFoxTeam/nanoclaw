#!/usr/bin/env node
/**
 * PreToolUse hook: sanitize Bash commands.
 * Strips secret env vars from the subprocess environment so agents
 * can't accidentally leak API keys via Bash tool.
 *
 * Stdin:  JSON { hook_event_name, tool_name, tool_input: { command } }
 * Stdout: JSON { hookSpecificOutput: { updatedInput: { command } } }
 */

const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const command = input.tool_input?.command;
    if (!command) {
      process.stdout.write('{}');
      return;
    }

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        updatedInput: {
          ...input.tool_input,
          command: unsetPrefix + command,
        },
      },
    }));
  } catch {
    process.stdout.write('{}');
  }
});
