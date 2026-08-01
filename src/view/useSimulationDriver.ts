import { useEffect, useState } from 'react';
import type { DynamoDbLiveSession, DynamoDbSessionSnapshot } from '../core/scenario/dynamoDbLiveSession.js';

/**
 * シミュレーションを実時間で回し、HUD 用のスナップショットを間引いて配る。
 *
 * ## なぜ Canvas の中 (useFrame) ではなく独立した rAF ループなのか
 *
 * HUD (HTML) と 3D の両方がシミュレーションの結果を要るため。
 * useFrame の中で駆動すると HUD へ値を持ち上げる経路が要り、Canvas の外に
 * シミュレーションの一部が漏れる。ここで回しておけば、3D 側は
 * `session.latest` を毎フレーム読むだけの純粋な描画係でいられる。
 *
 * ## なぜスナップショットを間引くのか
 *
 * 毎フレーム `setState` すると 60fps で React の再描画が走り、
 * 柱 50 本ぶんのオブジェクト生成が毎フレーム発生する。
 * HUD の数字は 10Hz もあれば十分読めるので、そこで止める。
 * 3D は React の再描画を経由せず `session.latest` を直接読むので影響を受けない。
 */
export function useSimulationDriver(session: DynamoDbLiveSession, hudHz = 10): DynamoDbSessionSnapshot {
  const [snapshot, setSnapshot] = useState<DynamoDbSessionSnapshot>(() => session.snapshot());

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let sinceSnapshot = 0;
    const interval = 1 / Math.max(1, hudHz);

    const loop = (now: number): void => {
      const deltaSeconds = (now - last) / 1000;
      last = now;

      session.advance(deltaSeconds);

      sinceSnapshot += deltaSeconds;
      if (sinceSnapshot >= interval) {
        sinceSnapshot = 0;
        setSnapshot(session.snapshot());
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [session, hudHz]);

  return snapshot;
}
