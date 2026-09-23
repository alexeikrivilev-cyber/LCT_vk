import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const benchmark = fileURLToPath(new URL('./benchmark.mjs', import.meta.url));

function event(value) {
  return 'data: ' + JSON.stringify(value) + '\n\n';
}

async function startServer(t) {
  let active = 0;
  let maximumActive = 0;
  const requests = [];
  const server = createServer(async (request, reply) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const role = request.headers['x-lct-semantic-role'];
    requests.push({ role, body });
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 12));
    const content = role === 'worker'
      ? '{"status":"ok","summary":"worker benchmark","nextAction":"continue"}'
      : '{"decision":"pass","reason":"supervisor benchmark"}';
    reply.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.write(event({
      id: 'benchmark-' + role,
      model: 'Qwen/Qwen3.8-27B',
      choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'private reasoning' } }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    reply.write(event({
      id: 'benchmark-' + role,
      model: 'Qwen/Qwen3.8-27B',
      choices: [{ index: 0, delta: { role: 'assistant', content: content.slice(0, 24) } }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    reply.write(event({
      id: 'benchmark-' + role,
      model: 'Qwen/Qwen3.8-27B',
      choices: [{ index: 0, delta: { content: content.slice(24) } }],
    }));
    reply.write(event({
      id: 'benchmark-' + role,
      model: 'Qwen/Qwen3.8-27B',
      choices: [],
      usage: { prompt_tokens: 31, completion_tokens: 12 },
    }));
    reply.end('data: [DONE]\n\n');
    active -= 1;
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return {
    baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
    requests,
    get maximumActive() { return maximumActive; },
  };
}

function runBenchmark(baseUrl, args, timeoutMs = 5000, profileMetadata = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [benchmark, ...args], {
      env: {
        ...process.env,
        LCT_SEMANTIC_BASE_URL: baseUrl,
        LCT_SEMANTIC_MODEL: 'Qwen/Qwen3.8-27B',
        LCT_SEMANTIC_API_KEY: '',
        LCT_BENCHMARK_TIMEOUT_MS: String(timeoutMs),
        LCT_INFERENCE_PROFILE: 'A100_BF16',
        MODEL_ID: 'Qwen/Qwen3.8-27B',
        MODEL_REVISION: '1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0',
        MODEL_DTYPE: 'bfloat16',
        LCT_BENCHMARK_GPU: 'A100 80GB',
        ...profileMetadata,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Benchmark child process timed out'));
    }, 10_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('warm benchmark records isolated, serial, and overlapping structured calls', async (t) => {
  const server = await startServer(t);
  const result = await runBenchmark(server.baseUrl, ['warm', '--repetitions', '1']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'warm');
  assert.equal(report.profile, 'A100_BF16');
  assert.equal(report.checkpoint, 'Qwen/Qwen3.8-27B');
  assert.equal(report.dtype, 'bfloat16');
  assert.equal(report.gpu, 'A100 80GB');
  assert.equal(report.results.length, 4);
  assert.deepEqual(report.summary.map((item) => item.name), [
    'worker-only', 'supervisor-only', 'serial-pair', 'overlapping-pair',
  ]);
  assert.ok(report.results.every((row) => row.requests.every((request) => request.ttftMs >= 0)));
  assert.ok(report.results.every((row) => row.requests.every((request) => request.contentTtftMs >= request.ttftMs)));
  assert.ok(report.results.every((row) => row.requests.every((request) => request.promptTokens === 31)));
  assert.ok(server.maximumActive >= 2);
  assert.ok(Number.isFinite(report.serialVsOverlapP50WallTimeReductionPercent));
  assert.ok(server.requests.every((request) => request.body.stream === true));
  assert.ok(server.requests.every((request) => request.body.response_format.type === 'json_schema'));
});

test('cold benchmark sends exactly one un-warmed Worker request', async (t) => {
  const server = await startServer(t);
  const result = await runBenchmark(server.baseUrl, ['cold']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'cold');
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, 'cold-first-worker');
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].role, 'worker');
});

test('benchmark maps timeout while draining a provider error body', async (t) => {
  const server = createServer((_request, reply) => {
    reply.writeHead(503, { 'content-type': 'text/plain' });
    reply.write('temporary error');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));

  const result = await runBenchmark('http://127.0.0.1:' + address.port + '/v1', ['warm'], 40, {
    LCT_INFERENCE_PROFILE: 'H100_FP8',
    MODEL_ID: 'Qwen/Qwen3.8-27B-FP8',
    MODEL_REVISION: '017b9c7af6b5689d5dd426a76e0bc077eb5ca20a',
    MODEL_DTYPE: 'auto',
    LCT_BENCHMARK_GPU: 'H100 80GB',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /TIMEOUT: inference request exceeded its client deadline/);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.profile, 'H100_FP8');
  assert.equal(failure.role, 'worker');
  assert.doesNotMatch(result.stderr, /controller is not defined/);
});
