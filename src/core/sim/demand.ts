/**
 * ある瞬間にサービスへ流れ込むリクエスト量。
 *
 * 負荷の生成側 (LoadProfile) とサービスモデル側 (DynamoDbTable など) の両方が使うため、
 * どちらにも属さない中立な場所に置く。
 */
export interface Demand {
  readonly readsPerSecond: number;
  readonly writesPerSecond: number;
}
