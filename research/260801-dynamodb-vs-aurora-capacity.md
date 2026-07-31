# DynamoDB と Aurora のキャパシティモデル調査 (2026-08-01)

M1〜M3 のシミュレーションモデルを組むための一次情報の整理。
**「公式に明記されている数値」と「広く引用されるが公式には明記されていない数値」を区別して記録する。**

## 1. DynamoDB

### 1-1. パーティションあたりのスループット上限 ★ 公式明記

> Every partition in a DynamoDB table is designed to deliver a maximum capacity of
> **3,000 read units per second and 1,000 write units per second**.

出典: [Best practices for designing and using partition keys effectively](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)

- 1 read unit = 4KB までの項目に対する強整合性読み取り 1 回/秒（結果整合性なら 2 回/秒）
- 1 write unit = 1KB までの項目に対する書き込み 1 回/秒

**項目サイズが効く**という点が見落とされやすい。公式の例:

> if the table has an item size of 20 KB, a single consistent read operation will consume 5 read units.
> This means you can concurrently drive **600 consistent read operations per second on that single item**
> before reaching the partition limits.

→ 20KB の項目なら、1 パーティションで秒 600 リクエストしか捌けない。
シミュレータでは**項目サイズを必ずパラメータに含める**こと。ここは体感させる価値が高い。

### 1-2. テーブル／アカウントの上限 ★ 公式明記

| 上限 | On-Demand | Provisioned |
|---|---|---|
| テーブルあたり | 40,000 RRU + 40,000 WRU | 40,000 RCU + 40,000 WCU |
| アカウントあたり | 適用なし | 80,000 RCU + 80,000 WCU |

いずれも引き上げ申請可能（初期既定値であって、ハードリミットではない）。

出典: [Quotas in Amazon DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html)

### 1-3. パーティションあたりのストレージ容量 ⚠️ 要注意

**ユーザーの当初の理解「パーティションごとに 1GB 程度のメモリ」は誤り**だったが、
訂正として広く言われる「1 パーティション = 10GB」も、**現行の公式ドキュメントには明記がない**。

現行ドキュメントで確認できるのは以下のみ:

- テーブルサイズに実用上の上限はない（"no practical limit on a table's size"）
- パーティションが容量いっぱいになると DynamoDB が自動で追加パーティションを割り当てる
- LSI を持たないテーブルでは、item collection は必要なだけ自動的に複数パーティションへ分割される

10GB という数値は、**LSI を持つテーブルの item collection サイズ上限**として
公式に存在するものが、パーティション容量の話と混同されて流通している可能性が高い。

出典: [Partitions and data distribution in DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.Partitions.html)

**シミュレータでの扱い**: 10GB を「パーティション分割の目安」として使うが、
コード上・UI 上で「公式明記ではない推定値」と注記する。教材が誤情報を再生産しないため。

### 1-4. パーティション数の推定式

現行の公式ドキュメントに式そのものの記載は無いが、旧 Developer Guide に載っていた式が以下:

```
partitions = ceil( max( RCU/3000 + WCU/1000, sizeGB/10 ) )
                        ~~~~~~~~~~~~~~~~~~~   ← 読み書きは「和」
```

**読み取りと書き込みを足す**のが要点。1 つのパーティションは読み取り容量と書き込み容量を
分け合っており、「3,000 RCU も 1,000 WCU も同時に丸ごと出せる」わけではないため、
必要なパーティション数は両者の合計で決まる。

当初 `max(RCU/3000, WCU/1000, sizeGB/10)` として実装していたが、
上記の理由から和に修正した（1,000 RCU + 40,000 WCU のテーブルで 40 → 41 に変わる）。

加えて、**一度分割したパーティションは元に戻らない**（スループットを下げても減らない）。
これは「一時的にプロビジョニングを上げると後で 1 パーティションあたりの取り分が減る」という
古典的な落とし穴の原因である。⚠️ M1 時点では未モデル化（`estimatePartitionCount` は
毎回ゼロから計算する）。履歴依存の再現は M2 以降。

### 1-4b. ハッシュ分散のむらは消せない ★ M1 の実装で判明

キーはハッシュ値でパーティションへ配られるため、**キーを完全に均等な重みで設計しても、
パーティションごとの負荷は均等にならない**。

実測（500 キーを 41 パーティションへ FNV-1a で配った場合）:

| | 割合 |
|---|---|
| 理想（均等） | 2.44% |
| 最も重いパーティション | **3.4%** |

その結果、40,000 WCU を積んだテーブルに 40,000 WCU を流すと、
最も重いパーティションは 40,000 × 0.034 ≈ 1,360 WCU を要求し、
物理上限 1,000 WCU に当たって**テーブル全体で 8.3% スロットルする**。

「均等に設計したのに 100% 使い切れない」のはバグではなくハッシュ分散の性質。
プロビジョニング値に対して余裕を持たせる必要がある理由がここにある。

### 1-5. アダプティブキャパシティ ★ 公式明記（挙動）

> Adaptive capacity applies to on-demand mode and provisioned capacity.

ホットパーティションに対し、他のアイドルなパーティションの余剰を回す仕組み。ただし:

- **回せる上限はパーティション上限そのもの（3,000 RCU / 1,000 WCU）**
- したがって**単一パーティションキーへの集中は救えない**（分割不能なため）

→ **M1 の山場**。アダプティブキャパシティを ON/OFF して、
「zipf 分布の偏りは救われるが、単一ホットキーは救われない」を体感させる。

### 1-6. バーストキャパシティ ★ 公式明記（ただし依存不可）

未使用のキャパシティを最大 300 秒ぶん保持し、瞬間的なスパイクに使える。
**数値自体は公式に明記されている**が、AWS 自身が「ベストエフォートであり依存すべきではない」
と注意しているため、設計の前提にはできない。

コード上は `documented-but-best-effort` という確度で扱う
（`documented` と一括りにすると「300 秒は保証されている」と誤読されるため）。

シミュレータではトークンバケットで表現する（容量 = 300 秒 × **頭割りの取り分**）。

⚠️ 実装上の重要な注意: 貯金が貯まる基準は「**頭割りの取り分 = 払っている分**」であって、
アダプティブキャパシティで一時的に増えた配分ではない。
ここを取り違えると、アダプティブキャパシティの配分は常に需要以下になる性質から
「差額 = 0」が恒久化し、**一度バーストを使い切ると二度と回復しない**という
実機と逆の挙動になる（M1 のレビューで発見・修正済み。回帰テストあり）。

### 1-7. バーストが障害を隠す ★ M1 の実装で判明

ホットパーティションが恒常的に容量を超えていても、
**バーストの貯金がある間は何事も起きていないように見える**。

実測（頭割り 400 WCU のパーティションに 919 WCU の需要）:

| 経過時間 | 状態 |
|---|---|
| 0〜約 230 秒 | スロットル 0%。完全に正常に見える |
| 約 230 秒〜 | 貯金が尽き、スロットル率が跳ね上がる |

「デプロイ直後は問題なかったのに数分後に壊れた」という事故の典型的な原因。
シミュレーションの観測時間を 60 秒にしていると**この現象を完全に見逃す**ため、
教材シナリオは 900 秒走らせている。

## 2. Aurora

### 2-1. writer は 1 台 ★

Aurora クラスタは writer インスタンス 1 台 + reader 最大 15 台。
書き込みは必ず writer 1 台を通る。**ユーザーの理解は正しい。**

（例外: Aurora Multi-Master は提供終了、Aurora DSQL / Limitless は別アーキテクチャなので M3 では扱わない）

### 2-2. max_connections はメモリから自動導出される ★ 公式明記

```
max_connections = GREATEST(
    {log(DBInstanceClassMemory/805306368)  * 45},
    {log(DBInstanceClassMemory/8187281408) * 1000}
)
```

- `log` は**底 2**（自然対数ではない）
- `DBInstanceClassMemory` はバイト単位。OS と RDS 管理デーモンが使う分を差し引いた実効値
- 小さいインスタンス（T 系）は 45 刻み、大きいインスタンス（R 系）は 1000 刻みで効く

出典:
- [Managing performance and scaling for Amazon Aurora MySQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Performance.html)
- [Resolve "Too many connections" error in Aurora MySQL](https://repost.aws/knowledge-center/aurora-mysql-max-connection-errors)

公式は「max_connections を既定より上げるのはベストプラクティスではない。**インスタンスをスケールせよ**」としている。
→ これ自体が「垂直スケールしか手がない」という Aurora の性質を示しており、教材として使える。

### 2-3. Aurora のストレージ層は分散共有

通常の RDS と異なり、Aurora はストレージを 3AZ × 6 コピーの分散層に置く。
そのため **writer のボトルネックはディスク I/O ではなく、CPU・メモリ・コネクション数**に寄る。

シミュレータではこの点を反映し、writer の限界を
「IOPS」ではなく「同時接続数 × 1 接続あたりの処理能力」でモデル化する。

## 3. M1〜M3 で表現したい対比の核心

調査を通して、両者の差は**スケール方法**より**壊れ方**にあると結論した。

| | DynamoDB | Aurora writer |
|---|---|---|
| 限界に達したとき | **即座に拒否**（`ProvisionedThroughputExceededException`） | **待たせる**（接続待ち → 待ち行列） |
| クライアント側から見た症状 | エラー率が上がる。レイテンシは低いまま | エラーは出ない。レイテンシだけが指数的に伸びる |
| 自己復旧 | リトライ（指数バックオフ）で吸収可能 | 待ち行列が飽和すると雪崩れて自力で戻れない |
| 気づきやすさ | 気づきやすい（エラーが飛ぶ） | **気づきにくい**（動いてはいる） |

最後の行が最も実務的に重要。「DynamoDB はうるさく壊れ、Aurora は静かに壊れる」。

3D 表現もこの差が出るよう設計する:
- DynamoDB — 弾かれた粒子が赤く散る（拒否が目に見える）
- Aurora — 粒子が writer の手前で列を成して詰まる（滞留が目に見える）

## Sources

- [Best practices for designing and using partition keys effectively in DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)
- [Quotas in Amazon DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html)
- [Partitions and data distribution in DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.Partitions.html)
- [Managing performance and scaling for Amazon Aurora MySQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Performance.html)
- [Resolve "Too many connections" error in Aurora MySQL](https://repost.aws/knowledge-center/aurora-mysql-max-connection-errors)
