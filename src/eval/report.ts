import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { EvalReport } from './runner.ts';

type MetricsSnapshot = ReturnType<import('../observability/metrics.ts').Metrics['snapshot']>;

export async function writeReports(report: EvalReport, metrics: MetricsSnapshot): Promise<void> {
  await fs.mkdir(report.reportDir, { recursive: true });
  await fs.writeFile(join(report.reportDir, 'report.json'), `${JSON.stringify({ ...report, metrics }, null, 2)}\n`, 'utf8');
  await fs.writeFile(join(report.reportDir, 'summary.md'), renderMarkdown(report), 'utf8');
  await fs.writeFile(join(report.reportDir, 'junit.xml'), renderJUnit(report), 'utf8');
}

export function renderMarkdown(report: EvalReport): string {
  const summary = report.summary;
  const lines: string[] = [];
  lines.push(`# Agent evaluation ${report.runId}`);
  lines.push('');
  lines.push(`- provider: \`${report.provider}\`${report.model ? ` / \`${report.model}\`` : ''}`);
  lines.push(`- success rate: **${(summary.successRate * 100).toFixed(1)}%** (${summary.passed}/${summary.total})`);
  lines.push(`- steps: avg ${summary.avgSteps}, tool calls: avg ${summary.avgToolCalls}, tool error rate: ${(summary.toolErrorRate * 100).toFixed(1)}%`);
  lines.push(`- duration: p50 ${summary.p50DurationMs}ms, p95 ${summary.p95DurationMs}ms, total ${summary.durationMs}ms`);
  lines.push(`- tokens: ${summary.totalTokens}`);
  lines.push(`- baseline updated: ${report.baseline.updated}`);
  if (report.baseline.regressions.length > 0) {
    lines.push(`- regressions: ${report.baseline.regressions.join(', ')}`);
  }
  lines.push('');
  lines.push('| scenario | role | result | steps | tools | errors | duration | trace |');
  lines.push('|---|---|---|---:|---:|---:|---:|---|');
  for (const scenario of report.scenarios) {
    const trace = scenario.traceFile ? `\`${scenario.traceFile}\`` : '';
    lines.push(
      `| ${scenario.id} | ${scenario.role} | ${scenario.ok ? 'PASS' : 'FAIL'} | ${scenario.metrics.steps} | ${scenario.metrics.toolCalls} | ${scenario.metrics.toolErrors} | ${scenario.metrics.durationMs}ms | ${trace} |`
    );
  }
  lines.push('');
  for (const scenario of report.scenarios) {
    lines.push(`## ${scenario.id}: ${scenario.title}`);
    lines.push('');
    if (scenario.error) {
      lines.push(`Execution error: \`${scenario.error}\``);
      lines.push('');
    }
    const failed = scenario.assertions.filter((assertion) => !assertion.ok && assertion.severity === 'error');
    const passed = scenario.assertions.filter((assertion) => assertion.ok);
    if (failed.length > 0) {
      lines.push('Failed assertions:');
      for (const assertion of failed) {
        lines.push(`- **${assertion.name}**: ${assertion.detail}`);
      }
      lines.push('');
    }
    lines.push(`Passed ${passed.length}/${scenario.assertions.length} assertions.`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function renderJUnit(report: EvalReport): string {
  const failures = report.summary.failed;
  const time = (report.summary.durationMs / 1000).toFixed(3);
  const cases = report.scenarios
    .map((scenario) => {
      const failed = scenario.assertions.filter((assertion) => !assertion.ok && assertion.severity === 'error');
      const timeSeconds = (scenario.metrics.durationMs / 1000).toFixed(3);
      const body = failed
        .map((assertion) => `      <failure message="${escapeXml(assertion.name)}">${escapeXml(assertion.detail)}</failure>`)
        .join('\n');
      return `  <testcase classname="sysml-ai.${escapeXml(scenario.role)}" name="${escapeXml(scenario.id)}" time="${timeSeconds}">\n${body}\n  </testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="sysml-ai-agents" tests="${report.summary.total}" failures="${failures}" time="${time}">
${cases}
</testsuite>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
