/**
 * シナリオを走らせて結果を標準出力に表示する CLI。
 *
 * 3D を作る前に、モデルが正しく振る舞っているかを数値で確かめるための足場。
 * View 層に依存を持たないので、Core だけで完結して検証できる。
 *
 *   npm run scenario              全プリセットを実行
 *   npm run scenario single-hot-key   1 つだけ実行し、パーティションの内訳も出す
 */
import { findPreset, presets } from '../scenario/presets.js';
import { runScenario, type ScenarioResult } from '../scenario/runScenario.js';

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function printSummary(result: ScenarioResult): void {
  const { scenario, summary } = result;
  console.log(`\n━━ ${scenario.name} ━━`);
  console.log(`  ${scenario.lesson}`);
  console.log(
    `  パーティション数: ${summary.partitionCount} (均等なら 1 本あたり ${formatPercent(summary.idealShare)})`,
  );

  for (const [label, lane] of [
    ['読み取り', summary.read],
    ['書き込み', summary.write],
  ] as const) {
    if (lane.demandedRequests === 0) continue;
    const verdict = lane.throttleRate > 0.001 ? '⛔ スロットル発生' : '✅ 全部通った';
    console.log(
      `  ${label}: 要求 ${formatCount(lane.demandedRequests)} / ` +
        `通過 ${formatCount(lane.acceptedRequests)} / ` +
        `弾かれ ${formatCount(lane.throttledRequests)} ` +
        `(テーブル全体 ${formatPercent(lane.throttleRate)}) ${verdict}`,
    );

    const hottest = lane.hottest;
    if (hottest === undefined) continue;
    // テーブル全体の数字とホットパーティション単体の数字を必ず並べる。
    // この 2 つの乖離こそが「集計値は障害を隠す」という一番伝えたい事実。
    const gap = hottest.throttleRate - lane.throttleRate;
    const warning = gap > 0.05 ? '  ← 全体の数字が隠している' : '';
    console.log(
      `    最も熱い P#${hottest.index}: ` +
        `全トラフィックの ${formatPercent(hottest.trafficShare)} を受け持ち、` +
        `単体スロットル率 ${formatPercent(hottest.throttleRate)}${warning}`,
    );
  }
}

function printPartitionBreakdown(result: ScenarioResult): void {
  const lastTick = result.ticks.at(-1);
  if (lastTick === undefined) return;

  // 需要が大きい方のレーンだけ出す。両方出すと読みづらい。
  const lane =
    lastTick.write.demandedRequestsPerSec >= lastTick.read.demandedRequestsPerSec
      ? { name: '書き込み', data: lastTick.write }
      : { name: '読み取り', data: lastTick.read };

  console.log(`\n  ── 最終 tick の${lane.name}パーティション内訳 (需要の多い順・上位 8) ──`);
  const sorted = [...lane.data.partitions]
    .sort((a, b) => b.demandedUnitsPerSec - a.demandedUnitsPerSec)
    .slice(0, 8);

  for (const partition of sorted) {
    const bar = '█'.repeat(Math.min(30, Math.round(partition.utilization * 10)));
    const state = partition.throttledUnitsPerSec > 0.001 ? '⛔' : '  ';
    console.log(
      `  ${state} P#${String(partition.index).padStart(2)} ` +
        `需要 ${partition.demandedUnitsPerSec.toFixed(0).padStart(6)} u/s / ` +
        `枠 ${partition.allowanceUnitsPerSec.toFixed(0).padStart(5)} u/s / ` +
        `弾かれ ${partition.throttledUnitsPerSec.toFixed(0).padStart(6)} u/s ` +
        `${bar}`,
    );
  }
}

function main(): void {
  const requested = process.argv[2];

  if (requested !== undefined) {
    const scenario = findPreset(requested);
    if (scenario === undefined) {
      console.error(`シナリオが見つからない: ${requested}`);
      console.error(`利用可能: ${presets.map((s) => s.name).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const result = runScenario(scenario);
    printSummary(result);
    printPartitionBreakdown(result);
    console.log('');
    return;
  }

  console.log('DynamoDB パーティションモデル — 全プリセット');
  for (const scenario of presets) {
    printSummary(runScenario(scenario));
  }
  console.log('\n個別に詳細を見る: npm run scenario <name>\n');
}

main();
