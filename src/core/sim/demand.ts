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

/**
 * 読み取り / 書き込みのどちらのレーンを指しているか。
 *
 * 「レーン」は `DynamoDbTable` の用語に見えるが、実体は
 * **`Demand` の 2 本のうちどちらか**というサービス非依存の区別なので、ここに置く。
 *
 * ⚠️ 元は `scenario/dynamodb/liveSession.ts` にあった。View の read/write トグルの型が
 * そこにあると、Aurora 側が同じトグルを共有した瞬間に
 * 「Aurora が DynamoDB のセッションを import する」という不自然な依存が生まれる。
 * トグルは負荷ダイヤルの一部であって、どちらのサービスにも属さない。
 */
export type LaneKind = 'read' | 'write';
