#!/usr/bin/env node
// 轻盘 · tools/list 探测脚本
//
// 做什么：握手 → 读取工具清单 → 把每个工具的入参 schema 存到 probe/ 目录。
// 不做什么：默认不调用任何工具（tools/call 一次都不发），不读你的账户、券、订单。
//   加 --smoke 时只额外调用 now-time-info（返回当前时间，不含个人信息）做连通冒烟。
//
// 用法：
//   export MCD_MCP_TOKEN='你的新 Token'   # 只放本机环境变量，别写进文件
//   node scripts/probe-tools.mjs [--smoke] [--out probe]

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { McpClient, McpError, DEFAULT_URL, isReadTool } from './mcp-client.mjs';

export function summarize(tools) {
  return tools
    .map((t) => {
      const props = t.inputSchema?.properties ?? {};
      const required = new Set(t.inputSchema?.required ?? []);
      const params = Object.entries(props).map(([k, v]) => ({
        name: k,
        type: v?.type ?? (v?.enum ? 'enum' : 'any'),
        required: required.has(k),
        description: v?.description ?? '',
      }));
      return {
        name: t.name,
        title: t.title ?? t.annotations?.title ?? '',
        description: t.description ?? '',
        readOnly: isReadTool(t.name),
        params,
        inputSchema: t.inputSchema ?? null,
        outputSchema: t.outputSchema ?? null,
        annotations: t.annotations ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function toMarkdown(summary, meta) {
  const lines = [
    '# 麦当劳中国 MCP 工具清单（探测结果）',
    '',
    `- 探测时间：${meta.probedAt}`,
    `- 服务端：${meta.serverName ?? '未知'} ${meta.serverVersion ?? ''}`.trimEnd(),
    `- 协商协议版本：${meta.protocolVersion}`,
    `- 工具数：${summary.length}（只读 ${summary.filter((t) => t.readOnly).length}，其余按写操作处理）`,
    '',
  ];
  for (const t of summary) {
    lines.push(`## ${t.name}${t.readOnly ? '' : '  ⚠️ 写操作/未入白名单'}`);
    if (t.title) lines.push(`**${t.title}**`, '');
    if (t.description) lines.push(t.description.trim(), '');
    if (t.params.length) {
      lines.push('| 参数 | 类型 | 必填 | 说明 |', '|---|---|---|---|');
      for (const p of t.params) {
        const desc = String(p.description).replace(/\|/g, '\\|').replace(/\n/g, ' ');
        lines.push(`| ${p.name} | ${p.type} | ${p.required ? '是' : ''} | ${desc} |`);
      }
    } else {
      lines.push('（无参数）');
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function probe({ token, url = DEFAULT_URL, smoke = false, fetchImpl } = {}) {
  const client = new McpClient({ token, url, fetchImpl });
  const t0 = Date.now();
  const init = await client.initialize();
  const tInit = Date.now() - t0;
  const tools = await client.listTools();
  const tList = Date.now() - t0 - tInit;

  let smokeResult = null;
  if (smoke) {
    const t1 = Date.now();
    try {
      const r = await client.callTool('now-time-info', {});
      smokeResult = { ok: !r?.isError, ms: Date.now() - t1 };
    } catch (e) {
      smokeResult = { ok: false, ms: Date.now() - t1, error: e.message };
    }
  }

  const meta = {
    probedAt: new Date().toISOString(),
    serverName: init?.serverInfo?.name,
    serverVersion: init?.serverInfo?.version,
    protocolVersion: client.negotiated,
    latencyMs: { initialize: tInit, toolsList: tList },
    smoke: smokeResult,
  };
  return { meta, summary: summarize(tools) };
}

async function main() {
  const args = process.argv.slice(2);
  const smoke = args.includes('--smoke');
  const outIdx = args.indexOf('--out');
  const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : 'probe');
  const token = process.env.MCD_MCP_TOKEN;
  const url = process.env.MCD_MCP_URL || DEFAULT_URL;

  if (!token) {
    console.error('✗ 没有找到环境变量 MCD_MCP_TOKEN');
    console.error("  先执行：export MCD_MCP_TOKEN='你的 Token'（只放本机，不要写进任何文件）");
    process.exit(2);
  }

  console.log(`→ 连接 ${url} …`);
  try {
    const { meta, summary } = await probe({ token, url, smoke });
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'tools.json'), JSON.stringify({ meta, tools: summary }, null, 2) + '\n');
    await writeFile(join(outDir, 'tools.md'), toMarkdown(summary, meta) + '\n');

    console.log(`✓ 握手成功：协议 ${meta.protocolVersion}，耗时 ${meta.latencyMs.initialize}ms`);
    console.log(`✓ 读取到 ${summary.length} 个工具，耗时 ${meta.latencyMs.toolsList}ms`);
    for (const t of summary) {
      const req = t.params.filter((p) => p.required).map((p) => p.name);
      console.log(`  ${t.readOnly ? '·' : '!'} ${t.name}${req.length ? `  必填: ${req.join(', ')}` : ''}`);
    }
    if (meta.smoke) console.log(`${meta.smoke.ok ? '✓' : '✗'} 冒烟 now-time-info：${meta.smoke.ms}ms`);
    console.log(`✓ 已写入 ${join(outDir, 'tools.json')} 和 tools.md（不含任何个人信息）`);
  } catch (e) {
    if (e instanceof McpError) {
      console.error(`✗ ${e.message}`);
      if (e.hint) console.error(`  建议：${e.hint}`);
    } else {
      console.error(`✗ 未预期的错误：${e?.message ?? e}`);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
