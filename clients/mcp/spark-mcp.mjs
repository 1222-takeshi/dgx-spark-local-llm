// MCP server exposing the Spark model gate to Cursor via stdio (Issue #10).
// stdout carries ONLY JSON-RPC; logs go to stderr; never print the token.
import {join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {loadConfig,redact} from '../doctor.mjs';

export const SERVER_INFO = { name: 'spark-local-llm', version: '0.1.0' };
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const TOOL = {
  name: 'local_llm',
  description: 'Send a prompt to the local LLM on the DGX Spark (Tailscale gate) and return its reply text.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'User message.' },
      system: { type: 'string', description: 'Optional system message.' },
      max_tokens: { type: 'integer', minimum: 1, maximum: 32768, description: 'Default 4096.' },
      temperature: { type: 'number', minimum: 0, maximum: 2 },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
};

const DEFAULT_TOKENS = 4096;
function configDir() {
  return process.env.SPARK_LLM_CONFIG_DIR || join(homedir(), '.config', 'spark-llm');
}

function errResponse(msg, code, message) {
  const id = (msg && typeof msg === 'object' && msg.id !== undefined) ? msg.id : null;
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function textResult(id, text, isError) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } };
}

export async function handleMessage(msg, deps) {
  const { fetch, getConfig, timeoutMs } = deps;
  if (typeof msg !== 'object' || msg === null || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return errResponse(msg, -32600, 'Invalid Request');
  }
  // A well-formed request carrying no `id` is a notification: acknowledge it
  // silently (no response), but only after rejecting structurally invalid input.
  if (msg.id === undefined) {
    return null;
  }
  const id = msg.id ?? null;
  const method = msg.method;
  const params = msg.params || {};

  if (method === 'initialize') {
    const requested = params.protocolVersion;
    const protocolVersion = typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : PROTOCOL_VERSIONS[0];
    return { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO } };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [TOOL] } };
  }

  if (method === 'tools/call') {
    return await handleToolCall(id, params, { fetch, getConfig, timeoutMs });
  }

  return errResponse(msg, -32601, 'Method not found: ' + method);
}

async function handleToolCall(id, params, { fetch, getConfig, timeoutMs }) {
  const name = params && params.name;
  if (name !== 'local_llm') {
    return errResponse({ id }, -32602, 'Unknown tool: ' + name);
  }
  const args = params && params.arguments;
  const reason = validateArgs(args);
  if (reason) {
    return textResult(id, 'invalid arguments: ' + reason, true);
  }
  let config;
  try {
    config = await getConfig();
  } catch (err) {
    // Errors may contain the home directory (homedir() and, when set, HOME).
    // Cursor's cloud model sees this text, so never leak the real path.
    let message = err.message;
    for (const p of [process.env.HOME, homedir()].sort((a, b) => (b || '').length - (a || '').length)) {
      if (p && message.includes(p)) message = message.split(p).join('~');
    }
    return textResult(id, 'config error: ' + message, true);
  }
  const { base_url, model, token } = config;
  const messages = [];
  if (args.system !== undefined) messages.push({ role: 'system', content: args.system });
  messages.push({ role: 'user', content: args.prompt });
  const body = { model, messages, max_tokens: args.max_tokens ?? DEFAULT_TOKENS };
  if (args.temperature !== undefined) body.temperature = args.temperature;

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(base_url + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    if (res.status !== 200) {
      return textResult(id, 'HTTP ' + res.status + ': ' + redact(text, token).slice(0, 300), true);
    }
    let json;
    try { json = JSON.parse(text); } catch { return textResult(id, 'empty reply', true); }
    const choice = json && json.choices && json.choices[0] ? json.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : null;
    if (typeof content === 'string' && content.length) {
      return textResult(id, content, false);
    }
    if (choice && choice.finish_reason === 'length') {
      return textResult(id, 'truncated: raise max_tokens (finish_reason=length)', true);
    }
    return textResult(id, 'empty reply', true);
  } catch (err) {
    return textResult(id, 'request failed: ' + redact(err && err.message || err, token), true);
  }
}

function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  if (typeof args.prompt !== 'string' || args.prompt.length === 0) return 'prompt must be a non-empty string';
  if (args.system !== undefined && typeof args.system !== 'string') return 'system must be a string';
  if (args.max_tokens !== undefined) {
    if (typeof args.max_tokens !== 'number' || !Number.isInteger(args.max_tokens)) return 'max_tokens must be an integer';
    if (args.max_tokens < 1 || args.max_tokens > 32768) return 'max_tokens out of range';
  }
  if (args.temperature !== undefined) {
    if (typeof args.temperature !== 'number') return 'temperature must be a number';
    if (args.temperature < 0 || args.temperature > 2) return 'temperature out of range';
  }
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(TOOL.inputSchema.properties, key)) {
      return 'unknown key: ' + key;
    }
  }
  return null;
}

export function createServer({ input, output, deps }) {
  // One chain enqueues line handling and every write, so responses come out
  // exactly in arrival order. The token never reaches here.
  let tail = Promise.resolve();
  const step = (task) => { tail = tail.then(task); };
  const writeLine = (line) => step(() => new Promise((resolve) => { output.write(line, resolve); }));
  let buffer = '';
  const flush = (raw) => step(async () => {
    if (!raw || !raw.trim()) return;
    let msg;
    try { msg = JSON.parse(raw); }
    catch {
      writeLine(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const result = await handleMessage(msg, deps);
    if (result !== null) writeLine(JSON.stringify(result) + '\n');
  });
  input.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      flush(raw);
    }
  });
  // 'data' events all fire before 'end', so at 'end' `tail` covers every line
  // handled so far. A final line with no trailing '\n' can only survive in the
  // leftover buffer, so flush it now, then resolve once that flush and every
  // earlier write have drained.
  let done = new Promise((resolve) => {
    input.on('end', () => {
      if (buffer) flush(buffer);
      buffer = '';
      tail.then(resolve);
    });
  });
  return done;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deps = {
    fetch,
    timeoutMs: Number(process.env.SPARK_MCP_TIMEOUT_MS) || 600000,
    getConfig: () => loadConfig(configDir()),
  };
  createServer({ input: process.stdin, output: process.stdout, deps });
}
