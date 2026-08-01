import { describe, expect, it } from 'vitest';
import { DynamoDbLiveSession, type DynamoDbLiveSettings } from '../src/core/scenario/dynamodb/liveSession.js';
import { defaultDynamoDbLivePreset, findDynamoDbLivePreset, dynamoDbLivePresets } from '../src/core/scenario/dynamodb/livePresets.js';
import { PARTITION_MAX_WRITE_UNITS_PER_SEC } from '../src/core/services/dynamodb/limits.js';

const baseSettings: DynamoDbLiveSettings = {
  readsPerSecond: 0,
  writesPerSecond: 30_000,
  distribution: { kind: 'uniform' },
  keyCount: 500,
  capacity: {
    mode: 'provisioned',
    readCapacityUnits: 1_000,
    writeCapacityUnits: 40_000,
    adaptiveCapacity: true,
  },
  tableSizeGb: 10,
  itemSizeKb: 1,
  consistentRead: true,
};

/** `seconds` 秒ぶん進める。フレームは 60fps 相当。 */
function advanceSeconds(session: DynamoDbLiveSession, seconds: number): void {
  const frames = Math.ceil(seconds * 60);
  for (let i = 0; i < frames; i += 1) session.advance(1 / 60);
}

describe('DynamoDbLiveSession', () => {
  it('負荷だけを変えてもテーブルを作り直さない', () => {
    const session = new DynamoDbLiveSession(baseSettings);
    advanceSeconds(session, 1);
    const before = session.table;

    const rebuilt = session.update({ writesPerSecond: 35_000 });

    expect(rebuilt).toBe(false);
    expect(session.table).toBe(before);
    // 経過時間もバーストの貯金も維持される（ダイヤルを回しただけなので）。
    expect(session.snapshot().simulatedSeconds).toBeGreaterThan(0);
  });

  it('テーブルの形が変わる設定はテーブルを作り直す', () => {
    const session = new DynamoDbLiveSession(baseSettings);
    advanceSeconds(session, 1);
    const before = session.table;

    const rebuilt = session.update({ distribution: { kind: 'singleHot', hotRatio: 0.9 } });

    expect(rebuilt).toBe(true);
    expect(session.table).not.toBe(before);
    expect(session.generation).toBe(1);
    // 作り直したら仮想時間も 0 から。
    expect(session.snapshot().simulatedSeconds).toBe(0);
  });

  it('同じ内容の設定を渡し直しても作り直さない（プロパティの順序が違っても）', () => {
    const session = new DynamoDbLiveSession(baseSettings);
    // キーの並び順だけを変えた、内容としては同一の設定。
    const reordered: DynamoDbLiveSettings = {
      consistentRead: true,
      itemSizeKb: 1,
      tableSizeGb: 10,
      capacity: {
        adaptiveCapacity: true,
        writeCapacityUnits: 40_000,
        readCapacityUnits: 1_000,
        mode: 'provisioned',
      },
      keyCount: 500,
      distribution: { kind: 'uniform' },
      writesPerSecond: 30_000,
      readsPerSecond: 0,
    };

    expect(session.replace(reordered)).toBe(false);
    expect(session.generation).toBe(0);
  });

  it('replace は省略可能なフィールドを残さない（プリセットを押す順序で結果が変わらない）', () => {
    // `big-item-trap` だけが initialBurstTokens: 0 を持つ。
    // replace がマージだと、そのあと他のプリセットを選んでも 0 が残り、
    // 「バーストの貯金が尽きるまで障害は表面化しない」という教材の山場が消える。
    const bigItem = findDynamoDbLivePreset('big-item-trap');
    const zipf = findDynamoDbLivePreset('zipf-without-adaptive');
    expect(bigItem).toBeDefined();
    expect(zipf).toBeDefined();
    if (bigItem === undefined || zipf === undefined) return;

    const direct = new DynamoDbLiveSession(zipf.settings);
    advanceSeconds(direct, 60);

    const viaBigItem = new DynamoDbLiveSession(bigItem.settings);
    viaBigItem.replace(zipf.settings);
    advanceSeconds(viaBigItem, 60);

    expect(viaBigItem.settings.initialBurstTokens).toBeUndefined();
    expect(viaBigItem.snapshot().write.hottest?.burstRatio).toBeCloseTo(
      direct.snapshot().write.hottest?.burstRatio ?? -1,
      10,
    );
    expect(viaBigItem.snapshot().write.throttleRate).toBe(0);
  });

  it('進める前でも snapshot が柱の本数ぶん揃っている（View に分岐を持ち込まないため）', () => {
    const session = new DynamoDbLiveSession(baseSettings);
    const snapshot = session.snapshot();

    expect(snapshot.write.partitions).toHaveLength(session.table.partitionCount);
    expect(snapshot.write.partitions.every((p) => p.demandedUnitsPerSec === 0)).toBe(true);
    // 貯金は満タンから始まる。
    expect(snapshot.write.partitions.every((p) => p.burstRatio === 1)).toBe(true);
  });

  it('singleHot では 1 本だけが物理上限を振り切り、他は冷たいまま', () => {
    const session = new DynamoDbLiveSession({
      ...baseSettings,
      distribution: { kind: 'singleHot', hotRatio: 0.9 },
    });
    advanceSeconds(session, 5);

    const { write } = session.snapshot();
    const hottest = write.hottest;
    expect(hottest).toBeDefined();
    if (hottest === undefined) return;

    // 30,000 WCU の 9 割 = 27,000 が 1 本に集中する。物理上限 1,000 の 27 倍。
    expect(hottest.utilizationVsHardCap).toBeGreaterThan(20);
    expect(hottest.demandedUnitsPerSec).toBeGreaterThan(PARTITION_MAX_WRITE_UNITS_PER_SEC);

    const others = write.partitions.filter((p) => p.index !== hottest.index);
    expect(others.every((p) => p.utilizationVsHardCap < 1)).toBe(true);

    // 全体のスロットル率はホットパーティション単体より**軽く見える**。
    // 集計値がホットパーティションを隠す、という M1 の発見が View にも出ている。
    expect(write.throttleRate).toBeLessThan(hottest.throttleRate);
  });

  it('バーストの貯金が尽きるまでスロットルは表面化しない（急に壊れる理由が見える）', () => {
    // M1 の発見 2:「バーストキャパシティが障害を数分間隠す」。
    // 貯金が目に見えないと、View 上で「なぜ急に壊れたのか」が分からない。
    const preset = findDynamoDbLivePreset('zipf-without-adaptive');
    expect(preset).toBeDefined();
    if (preset === undefined) return;

    const session = new DynamoDbLiveSession(preset.settings);

    advanceSeconds(session, 60);
    const early = session.snapshot().write.hottest;
    expect(early?.throttleRate).toBe(0); // 何も起きていないように見える
    expect(early?.burstRatio).toBeLessThan(1); // が、貯金は既に減っている
    expect(early?.burstDrawUnitsPerSec).toBeGreaterThan(0);

    advanceSeconds(session, 540);
    const later = session.snapshot().write.hottest;
    expect(later?.burstRatio).toBeLessThan(early?.burstRatio ?? 1);
    expect(later?.throttleRate).toBeGreaterThan(0); // 貯金が尽きた瞬間に壊れる
  });

  it('アダプティブの ON/OFF で受理量が変わる（赤熱の指標そのものは変わらない）', () => {
    const zipf = findDynamoDbLivePreset('zipf-without-adaptive');
    const zipfAdaptive = findDynamoDbLivePreset('zipf-with-adaptive');
    expect(zipf).toBeDefined();
    expect(zipfAdaptive).toBeDefined();
    if (zipf === undefined || zipfAdaptive === undefined) return;

    const off = new DynamoDbLiveSession(zipf.settings);
    const on = new DynamoDbLiveSession(zipfAdaptive.settings);
    // バーストの貯金が尽きるまで進めないと差が出ない (M1 の発見)。
    advanceSeconds(off, 400);
    advanceSeconds(on, 400);

    const offHot = off.snapshot().write.hottest;
    const onHot = on.snapshot().write.hottest;
    expect(offHot).toBeDefined();
    expect(onHot).toBeDefined();
    if (offHot === undefined || onHot === undefined) return;

    // アダプティブは「通る量」を変える。
    expect(onHot.acceptedUnitsPerSec).toBeGreaterThan(offHot.acceptedUnitsPerSec);
    // 一方で需要そのものは変わらないので、赤熱の指標 (需要/物理上限) は動かない。
    // View で「アダプティブを入れたのに色が変わらない」のはバグではなくモデルの意味。
    expect(onHot.utilizationVsHardCap).toBeCloseTo(offHot.utilizationVsHardCap, 10);
  });
});

describe('dynamoDbLivePresets', () => {
  it('M1 のシナリオ名と 1 対 1 に対応している', () => {
    expect(dynamoDbLivePresets.map((p) => p.name)).toEqual([
      'uniform-healthy',
      'uniform-at-full-capacity',
      'single-hot-key',
      'single-hot-key-without-adaptive',
      'zipf-without-adaptive',
      'zipf-with-adaptive',
      'big-item-trap',
    ]);
    expect(dynamoDbLivePresets[0]).toBe(defaultDynamoDbLivePreset);
  });

  it('どのプリセットもそのままセッションを構築して進められる', () => {
    for (const preset of dynamoDbLivePresets) {
      const session = new DynamoDbLiveSession(preset.settings);
      advanceSeconds(session, 2);
      const snapshot = session.snapshot();
      expect(snapshot.partitionCount).toBeGreaterThan(0);
      expect(snapshot[preset.focusLane].demandedRequestsPerSec).toBeGreaterThan(0);
    }
  });

  it('big-item-trap は 20KB 項目で 600 req/s の壁に当たる', () => {
    const preset = findDynamoDbLivePreset('big-item-trap');
    expect(preset).toBeDefined();
    if (preset === undefined) return;

    const session = new DynamoDbLiveSession(preset.settings);
    advanceSeconds(session, 5);
    const { read } = session.snapshot();

    // 3,000 read units/秒 ÷ 5 units (20KB) = 600 req/s。1,200 req/s 流せば半分弾かれる。
    expect(read.acceptedRequestsPerSec).toBeCloseTo(600, 0);
    expect(read.throttleRate).toBeCloseTo(0.5, 2);
  });
});
