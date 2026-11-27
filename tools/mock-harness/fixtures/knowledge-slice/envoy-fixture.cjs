/** [SIMULATION] 最小 MCP 服务，仅测试鲸屿边界；不声称真实 Envoy 能读 Markdown。 */
const { createInterface } = require('node:readline');
const { readFileSync, writeFileSync } = require('node:fs');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const mode = process.argv[2] || 'ready';
writeFileSync('fixture-env.json', JSON.stringify({ keys: Object.keys(process.env), pid: process.pid }));
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const rpc = JSON.parse(line);
  if (rpc.id === undefined || mode === 'hang') return;
  if (mode === 'exit') process.exit(2);
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) + '\n');
  let result;
  if (rpc.method === 'initialize') result = {
    protocolVersion: '2025-03-26',
    ...(mode === 'no-version' ? {} : { serverInfo: { name: 'envoy-fixture', version: process.env.FUSION_TEST_SECRET ? 'leaked' : 'fixture-1' } }),
  };
  else if (rpc.method === 'tools/list') {
    if (mode === 'slow-tools') { setTimeout(() => respond({ tools: [{ name: 'envoy_read' }] }), 300); return; }
    result = { tools: mode === 'no-tool' ? [] : [{ name: 'envoy_read' }, { name: 'envoy_knowledge' }, { name: 'publish' }] };
  }
  else if (rpc.method === 'tools/call') {
    if (rpc.params.name !== 'envoy_read') throw new Error('不允许写工具');
    if (mode === 'is-error') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { isError: true } }) + '\n'); return; }
    const text = readFileSync(fileURLToPath(rpc.params.arguments.source.url), 'utf8');
    const quote = mode === 'unlocatable' ? '这段文字不在材料中' : text.trimEnd().split('\n').at(-1);
    result = { structuredContent: {
      material_id: 'mat-fixture-spring',
      source_revision: createHash('sha256').update(text).digest('hex'),
      result: mode === 'blocked' ? 'blocked' : mode === 'partial' ? 'partial' : 'ready',
      blocks: [{ id: 'blk-body', origin: mode === 'derived' ? 'model_summary' : 'source_text', content: { type: 'text', text: quote } }],
      coverage: { modalities: { text: { extraction: mode === 'partial' ? 'partial' : 'complete' } }, unresolved: [] },
      errors: mode === 'blocked' ? [{ code: 'unsupported_source', message: '此版本不支持本地 Markdown' }] : [],
    } };
  } else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) + '\n');
});
