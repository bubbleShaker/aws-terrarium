# Aurora の待ち行列モデル調査 (2026-08-01)

M3「Aurora writer モデル追加。同じ負荷を両方に流して並置する」のための調査。

前提資料:
- `research/260801-dynamodb-vs-aurora-capacity.md` の 2 節（Aurora の一次情報）
- `PLAN.md` の「M3 の入口」「M3 で対比させる核心」

**この調査の結論を 1 行で**:

> Aurora の限界は「拒否する壁」ではなく **「vCPU 本数」という驚くほど低い壁**であり、
> その壁を越えてから最初のエラーが出るまでの数十秒間、
> **受理量も拒否量も DynamoDB と全く同じ数字を出しながら、レイテンシだけが 500 倍になる。**

---

## 1. なぜ Core に新しい概念が必要か

M2 までのモデルは **各 tick が独立**している。`DynamoDbTable.step()` は
「この tick の需要 → この tick の受理/スロットル」を計算して終わりで、
tick をまたぐ状態は `TokenBucket` の貯金だけ。しかも貯金は**単調に減る一方向の量**である。

待ち行列はこれと質が違う。**行列に並んだリクエストは次の tick にも存在し続ける**。
つまり Core に初めて「**滞留する仕事**」という状態が入る。

| | M2 まで | M3 で入るもの |
|---|---|---|
| tick をまたぐ状態 | バーストの貯金（減るだけ） | **待ち行列長 Q**（増えも減りもする） |
| 限界を超えたとき | その tick で捨てる | **翌 tick へ持ち越す** |
| 出力される指標 | スループット（量） | **レイテンシ（時間）** |
| 時間の役割 | tick は単なる刻み | tick は**積分の刻み幅** |

レイテンシという「時間の次元を持つ出力」が生まれるのが M3 の本質的な新しさ。
DynamoDB 側にレイテンシの概念が無かったのは、モデルの手抜きではなく
**拒否するサービスは待たせないから**であり、この非対称性こそが M3 の教材価値そのものである。

---

## 2. Aurora の壁は 1 枚ではなく 3 枚ある

「writer 1 台がボトルネック」は正しいが、**writer の中に性質の違う壁が 3 枚**ある。
どれが先に来るかで症状がまったく変わるため、モデルでは 3 枚を分けて持つ。

### 2-1. 壁A: vCPU 本数 ★ 公式明記

> One process can run on a vCPU at a time. **If the number of processes exceeds the number of vCPUs,
> the processes start queuing. When queuing increases, database performance decreases.**

出典: [Maximum CPU — Amazon Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.Overview.MaxCPU.html)

これは待ち行列理論の **M/M/c における c（窓口数）そのもの**を AWS 自身が明言している文である。
Performance Insights の **Max vCPU 線**が、そのまま c を示している。

> Performance Insights determines the **Max vCPU** value by the number of vCPU cores for your DB instance.

**この壁は拒否しない。ただ待たせる。** M3 の主役はこの壁。

### 2-2. 壁B: max_connections ★ 公式明記（表がある）

`research/260801-dynamodb-vs-aurora-capacity.md` 2-2 で式を記録したが、
**AWS は式の計算結果をそのまま使っていない**ことが今回判明した。

> Example: For db.r6g.large, while the formula calculates **1069.2**, the system implements **1000**
> to maintain consistent incremental patterns.

→ **シミュレータは式ではなく公式の表を使う**こと。式は「なぜその値なのか」の説明にのみ使う。

| インスタンスクラス | vCPU | メモリ | max_connections |
|---|---|---|---|
| db.t3.medium | 2 | 4 GiB | 90 |
| db.r6g.large | 2 | 16 GiB | **1,000** |
| db.r6g.xlarge | 4 | 32 GiB | 2,000 |
| db.r6g.2xlarge | 8 | 64 GiB | 3,000 |
| db.r6g.4xlarge | 16 | 128 GiB | 4,000 |
| db.r6g.8xlarge | 32 | 256 GiB | 5,000 |

出典: [Managing performance and scaling for Amazon Aurora MySQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Performance.html) /
[Hardware specifications for DB instance classes](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.DBInstanceClass.Summary.html)

**この壁は拒否する**（MySQL の `Too many connections`）。DynamoDB のスロットルと同じ挙動。
つまり **Aurora も最終的には拒否する**。PLAN.md の「拒否 vs 待ち行列」は、
正確には「**いきなり拒否 vs さんざん待たせてから拒否**」である。

### 2-3. 壁C: アプリ側の接続プール / RDS Proxy ★ 公式明記

RDS Proxy を挟むと、DB へ到達する前にもう 1 枚キューができる。

> RDS Proxy **queues or throttles** application connections that can't be served immediately from the
> connection pool, allowing your application to continue to scale **without abruptly failing** or
> overwhelming the database, **although latencies might increase.** However, if connection requests
> exceed the limits specified, RDS Proxy **rejects** application connections.

出典: [RDS Proxy concepts and terminology](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/rds-proxy.howitworks.html) /
[Configuration guidelines](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/rds-proxy-best-practices.configuration.html)

- **Connection borrow timeout** 既定 **120 秒**（最大 300 秒）。この時間だけ待たされてから諦める
- 0 に設定すると待たずに即エラー

「待たせてから拒否する」がここでも繰り返される。**キューは直列に 3 段ある**:

```
クライアント → [プール待ち行列] → [接続スロット] → [CPU 実行待ち行列] → 処理
                 timeout で諦める    上限で拒否        ただ待つ（無制限）
```

### 2-4. どの壁が先に来るか — これが最大の発見 ⚠️

**db.r6g.large: vCPU = 2、max_connections = 1,000。その比は 500 倍。**

CPU の待ち行列は **AAS が 2 を超えた瞬間**に始まる。
一方 `Too many connections` が出るのは **998 セッション先**。

> **並ぶ場所（1,000）が、捌ける本数（2）の 500 倍広い。**
> だから Aurora は「エラーを出さずに、ひたすら遅くなる」ことができる。

「メモリを増やせば max_connections が増える」は正しいが、
**それは待合室を広げているだけで、窓口は 1 本も増えていない**。
公式が「max_connections を上げるのはベストプラクティスではない、インスタンスをスケールせよ」
と言う理由が、この 2 と 1,000 の距離で説明できる。

**M3 で体感させたい 1 行**:
> 接続数の上限は、性能の上限ではない。待合室の広さでしかない。

---

## 3. Little の法則と AAS — AWS の画面が待ち行列理論そのもの

Performance Insights の **DBLoad** の単位は **AAS（Average Active Sessions）**。

> To get the average active sessions, Performance Insights samples the number of sessions
> concurrently running a query.

これは待ち行列理論の **L（系内客数）** の定義そのものである。したがって:

```
L = λ × W          （Little の法則）
AAS = スループット × 平均レイテンシ
```

そして AWS が引く **Max vCPU 線 = c**。つまり Performance Insights のあの画面は、
**利用率 ρ = AAS / MaxvCPU を可視化したグラフ**として読める。

| 待ち行列理論 | Performance Insights | 意味 |
|---|---|---|
| L（系内客数） | **AAS / DBLoad** | いま DB の中にいるセッション数 |
| c（窓口数） | **Max vCPU 線** | 同時に走れる本数 |
| ρ = λ/(cμ) | AAS ÷ Max vCPU | 1 を超えたら待ち行列 |
| λ（到着率） | QPS | |
| W（滞在時間） | クエリレイテンシ | |

**教材としての価値**: シミュレータの HUD をこの 4 つで作れば、
**学習者が本物の Performance Insights を初めて開いたときに、そのまま読める**。
モデルの内部変数と AWS の公式指標が 1 対 1 で対応するのは、この分野では稀。
→ M3 の HUD は「AAS と Max vCPU 線」の形にする。独自の指標名を発明しない。

---

## 4. 採用するモデル: 流体 + 統計項のハイブリッド

### 4-1. 検討した 3 案

| 案 | 内容 | 判定 |
|---|---|---|
| A. 閉形式のみ | Erlang C / Kingman の式で待ち時間を直接出す | ❌ ρ≥1 で無限大。過負荷を描けない |
| B. 流体モデルのみ | 行列長を tick ごとに積分する | ❌ ρ<1 で待ち時間が**常にゼロ**になる |
| C. **両者の和**（採用） | 背圧項（流体）+ 統計項（閉形式） | ✅ 全域で有限かつ現象が出る |

**案 B が駄目な理由は実際に回して分かった。** 決定論的な流体モデルは
「到着 ≤ 容量 なら行列は発生しない」ため、ρ = 0.98 でも待ち時間が厳密に 0 になる。
しかし現実には ρ = 0.95 の時点でレイテンシは跳ね上がっている。
**「飽和する前から遅くなる」という、キャパシティ設計で最も重要な現象が丸ごと消える。**

実測（c=2, μ=200 q/s/core, 総容量 400 q/s）:

| ρ | λ | 統計項 (Erlang C) | 背圧項 (流体) |
|---|---|---|---|
| 0.50 | 200 | 1.7 ms | 0.0 ms |
| 0.70 | 280 | 4.8 ms | 0.0 ms |
| 0.80 | 320 | 8.9 ms | 0.0 ms |
| 0.90 | 360 | 21.3 ms | 0.0 ms |
| 0.95 | 380 | **46.3 ms** | 0.0 ms |
| 0.98 | 392 | **121.3 ms** | 0.0 ms |

> 利用率を 50% → 95% に上げると、**使う容量は 1.9 倍なのに待ち時間は 28 倍**になる。
> これが「サーバは 8 割で回せ」と言われる理由であり、流体モデル単独では絶対に出ない。

### 4-2. 確定した更新式

```
状態: Q（待ち行列長。tick をまたいで持続する ← Core の新概念）

各 tick (dt = 0.1s):
  1. 実効容量     totalRate = c × μ × g(Q)        g は劣化係数（後述、既定 1.0）
  2. 到着         inflow    = λ·dt + retryFlow
  3. 受付         admitted  = min(inflow, maxConn − Q)     ← 壁B
     拒否         rejected  = inflow − admitted            ← Too many connections
  4. 行列へ       Q += admitted
  5. 処理         served    = min(Q, totalRate·dt)         ← 壁A
     行列から     Q -= served
  6. レイテンシ   W = Q / totalRate        （背圧項: いま並んでいる列が掃ける時間）
                    + Wq(c, μ, λ)          （統計項: Erlang C。ρ は 0.99 で頭打ち）
```

**なぜこの形か**:
- 背圧項は**過負荷と過渡状態**を担当する。ρ≥1 でも有限の値を返し、行列が伸びるほど素直に伸びる
- 統計項は**飽和以前**を担当する。ρ<1 での「ゆらぎによる待ち」を再現する
- 両者は担当する領域が重ならない（一方が効くとき他方はほぼ 0）ので、単純な和で繋いでよい

**決定論性**: この経路に乱数は 1 つも無い。Erlang C は式であってサンプリングではない。
DynamoDB 側（ハッシュ分散に PRNG を使う）より**さらに強く決定論的**になる。

⚠️ 統計項の ρ は **0.99 でクランプ必須**。実装時に取り違えて秒とミリ秒を混ぜたところ、
過負荷域で 2.5 秒の下駄が常時乗った。1/(1−ρ) は ρ→1 で発散するので、
**クランプを忘れると過負荷域の数字が全部壊れる**。

### 4-3. 閉形式はエンジンではなく「テストオラクル」に使う

M1 でバーストの健全性を**保存則**で検証したのと同じ構造を取る。

- ρ < 1 の定常状態では、モデルの出す W が **Erlang C の理論値と一致**することをテストで固定する
- Little の法則 `L = λW` が全 tick で成立することを不変条件にする
- 累計で `処理数 ≤ 容量 × 経過時間`（M1 と同じ保存則）

理論値が使える領域でだけ理論値に照合し、使えない領域（ρ≥1）は保存則で守る。

### 4-4. ばらつきをダイヤルにする（Kingman）

Erlang C は M/M/c、すなわち**サービス時間が指数分布**という仮定を置いている。
実際の SQL は「速いクエリばかりの中に、たまに重い集計が混ざる」ので、ばらつきはもっと大きい。

Kingman の近似（VUT 式）は、待ち時間をばらつき係数で調整できる:

```
Wq ≈ ( (c_a² + c_s²) / 2 ) × ( ρ / (1−ρ) ) × τ
      ~~~~~~~~~~~~~~~~~~~     ~~~~~~~~~~~     ~
      V: ばらつき             U: 利用率      T: 処理時間
```

出典: [Kingman's formula — Wikipedia](https://en.wikipedia.org/wiki/Kingman%27s_formula)

→ **「クエリのばらつき」をダイヤルとして出す価値が高い**。
同じ利用率・同じスループットのまま、ばらつきを上げるだけでレイテンシが伸びる。
「遅いクエリを 1 本混ぜると全体が遅くなる」を体感させられる。M3 に入れるかは要判断（§10）。

---

## 5. 過負荷で何が起きるか（実測）

λ を容量の 1.05〜3.0 倍にして 600 秒回した結果:

| ρ | 定常 Q | 受理 | 拒否 | **最初のエラーが出る時刻** |
|---|---|---|---|---|
| 1.05 | 960 (上限 1,000) | 400 q/s | 20 q/s | **48 秒** |
| 1.10 | 960 | 400 q/s | 40 q/s | **24 秒** |
| 1.50 | 960 | 400 q/s | 200 q/s | 4.8 秒 |
| 3.00 | 960 | 400 q/s | 800 q/s | 1.2 秒 |

**行列は max_connections で頭打ちになり、そこから先はあふれた分が拒否になる。**
受理量はどの過負荷でも 400 q/s で一定 — 容量は増えも減りもしない。

### 「静かに壊れる」区間の長さ（ρ = 1.05）

| 経過 | 状態 |
|---|---|
| 0 秒 | レイテンシ 0.1 秒超え |
| 5 秒 | 0.5 秒超え |
| 15 秒 | 1.0 秒超え |
| 35 秒 | 2.0 秒超え |
| **48 秒** | **ようやく最初のエラー** |

> わずか 5% の過負荷で、**48 秒間エラーが 1 件も出ないまま**レイテンシが 20 倍に伸びる。
> エラー率で監視していると、この 48 秒は完全に無風に見える。

これは M1 で見つけた「バーストが障害を数分間隠す」と**同じ構造の罠**である。
DynamoDB は貯金が障害を隠し、Aurora は待合室が障害を隠す。

### そして並置するとこうなる ← M3 の絵の核心

同じ 500 q/s を、どちらも容量 400 q/s 相当のサービスに流す:

| | 受理 | 拒否 | **レイテンシ** |
|---|---|---|---|
| DynamoDB | 400 q/s | 100 q/s | **5 ms**（一定） |
| Aurora | 400 q/s | 100 q/s | **2,646 ms** |

> **スループットの数字は完全に同一。違いはレイテンシにしか出ない。**
> CloudWatch でスループットとエラー率だけ並べたら、この 2 つは見分けがつかない。

M3 の 1 画面はこの表を絵にしたものになる。**並べないと絶対に気づけない**という
PLAN.md の主張が、そのまま数値で裏付けられた。

---

## 6. メタステーブル障害 — 「自力で戻れない」の正体

PLAN.md は「待ち行列が雪崩を打つと自力で戻れない」と書いているが、
**素の待ち行列モデルはちゃんと自力で戻る**ことが分かった。

実験: 安全な負荷 (ρ=0.9) → 30 秒スパイク (ρ=2.0) → 安全な負荷へ戻す

| モデル | スパイク直後 Q | 30 秒後 | 300 秒後 | 最終レイテンシ |
|---|---|---|---|---|
| 素の待ち行列 | 960 | **0** | 0 | 0.02 秒 |
| **再送あり** | 960 | **960** | **960** | **2.42 秒** |
| USL 劣化あり | 1,000 | 1,000 | 1,000 | 発散 |

**「戻らない」には増幅の仕組みが要る。** 行列が伸びるだけでは、負荷を戻せば行列は掃ける。

これは学術的に **metastable failure** と呼ばれる現象で、
**トリガーではなく持続フィードバックループ（sustaining effect）が本体**である。

> While retries are an excellent mechanism to mitigate transient failures, in rare occasions,
> they may form a **sustaining effect**: the additional workload from retries prevents the system
> to respond to requests on time, thereby leading to further client-side retries.

> By far, the most common sustaining effect is due to the **retry policy**, affecting more than 50% of
> the studied incidents.

出典: [Metastable Failures in Distributed Systems (Bronson et al., HotOS'21)](https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf) /
[Metastable Failures in the Wild (USENIX)](https://www.usenix.org/publications/loginonline/metastable-failures-wild) /
[Marc Brooker — Metastability and Distributed Systems](https://brooker.co.za/blog/2021/05/24/metastable.html)

### これは決定論的な単体テストになる ★

メタステーブルの定義は「**トリガーを取り除いても劣化状態が続く**」である。これはそのままテストにできる:

```
負荷を安全域へ戻したあと、
  再送なし → Q は 30 秒以内に 0 へ戻る
  再送あり → Q は 300 秒後も上限に張り付いたまま
```

M1 の「保存則テスト」に相当する、M3 の看板テストになる。

⚠️ **実装上の罠（v1 で踏んだ）**: 再送を「行列長に比例して増える」と書くと、
出力が **1e151** まで発散して数値として意味を失った。
再送は**有限のクライアント母集団で閉じる**必要がある
（返事待ちのリクエスト数を超えて再送は発生しえない）。
これを閉じないと、教材ではなく単なるオーバーフローになる。

---

## 7. Universal Scalability Law — 入れるかどうかは保留

USL は「同時実行数を増やすとスループットが**下がる**（retrograde）」を表す式。
競合 α と協調コスト β の 2 パラメータを持つ。

出典: [Universal Scalability Law (WSO2)](https://wso2.com/blog/research/scalability-modeling-using-universal-scalability-law/) /
[usl R package vignette (CRAN)](https://cran.r-project.org/web/packages/usl/vignettes/usl.pdf)

劣化係数 g(N) として組み込んだ実測（c=2, α=0.05, β=0.01）:

| 同時セッション | 実効容量 | 定格比 |
|---|---|---|
| 2 | 400 q/s | 100% |
| 10 | 286 q/s | 71% |
| 50 | 49 q/s | 12% |
| 100 | 14 q/s | 4% |
| 1,000 | ~0 q/s | **0%** |

⚠️ **このパラメータでは容量が完全にゼロになり、非現実的**。実機は劣化しても止まりはしない。
入れるなら g に下限（例: 20%）を設けるか、β をもっと小さく校正する必要がある。

**判断: M3 の初回スコープには入れない。** 理由:
- 教材の主題（拒否 vs 待ち行列）は USL 無しで完全に成立する（§5 の表が出る）
- 「戻らない」現象は**再送だけで再現できる**（§6）ので、USL は必須ではない
- α, β に公式の根拠が無い。**推測値でモデルを複雑にすると、教材の信頼性が落ちる**
  （M1 で「10GB は公式明記ではない」と注記した方針と同じ）

→ M4 以降で、校正方法とセットで再検討する。

---

## 8. 3D 表現への対応（View 層への引き渡し）

Core が出す状態と、PLAN.md が要求する絵の対応:

| Core の値 | 絵 |
|---|---|
| `Q`（行列長） | writer の手前に**並ぶ粒子の列の長さ**。これが伸びるのがそのまま見える |
| `maxConnections` | 待合室の**床の広さ**。Q がここまで来ると床が埋まる |
| `c`（vCPU 数） | writer の上の**窓口の本数**。ここだけ極端に少ないのが一目で分かる |
| `W`（レイテンシ） | 粒子が入口から出口まで到達する**実時間**。遅いほど粒子がゆっくり進む |
| `rejected` | 待合室が満杯であふれた粒子（**ここで初めて赤くなる**） |
| `served` | 出口から出ていく粒子。過負荷でも一定なのが見える |

**DynamoDB との視覚的対比**（PLAN.md の要求そのまま）:
- DynamoDB — 柱の頂上で**即座に赤く散る**。列は作らない
- Aurora — writer の手前で**列を成して詰まる**。赤くなるのはずっと後

> 「2 と 1,000」の対比は、**窓口 2 本の後ろに 1,000 席の待合室**という絵にすればそのまま伝わる。

---

## 9. 既定パラメータ案

```ts
{
  instanceClass: 'db.r6g.large',  // vCPU 2 / メモリ 16GiB / max_connections 1000
  vcpu: 2,
  maxConnections: 1000,
  serviceTimeMs: 5,               // 1 クエリの平均処理時間 → μ = 200 q/s/core
  // → 総容量 400 q/s。DynamoDB 側と桁を揃えて並置しやすくする
}
```

`serviceTimeMs` は**公式の値が存在しない**（ワークロード次第）。
UI 上で「これは仮定値であり、実測が必要な唯一のパラメータ」と明示する。
逆に vCPU と max_connections は公式表の値なので、そこは動かさない。

---

## 10. M3 のスコープ

**含める**:
- vCPU を窓口数とする待ち行列（壁A）と max_connections による拒否（壁B）
- 背圧項 + 統計項のハイブリッドなレイテンシ
- AAS / Max vCPU の HUD（Performance Insights と同じ読み方）
- 再送によるメタステーブル障害と、その決定論的テスト
- DynamoDB との 1 画面並置

**含めない**（理由つき）:
- USL による容量劣化 — §7 の通り、公式根拠が無く校正できない
- RDS Proxy の 3 段目のキュー（壁C）— 壁A/B で主題は成立する。M4 以降
- Kingman のばらつきダイヤル — 価値は高い（§4-4）が、まず基本形を通す
- reader / レプリカラグ — 書き込みの話に集中する
- Aurora Serverless v2 の自動スケール — 「垂直・手動」という対比が崩れるため意図的に外す

---

## 11. 既存 PLAN.md への訂正提案

調査の結果、PLAN.md の記述で**不正確になった箇所が 2 つ**ある。

1. **「DynamoDB = 拒否する / Aurora = 待たせる」は二分法として不正確。**
   Aurora も max_connections で拒否する。正しくは
   「**即座に拒否する / さんざん待たせてから拒否する**」。
   むしろ**遅れて拒否するほうが厄介**（気づいたときには待ち行列が埋まっている）という点が本質。

2. **「待ち行列が雪崩を打つと自力で戻れない」は無条件には成り立たない。**
   素の待ち行列は自力で戻る（§6 実測）。戻れなくなるのは**再送などの増幅がある場合のみ**。
   「行列が伸びること」と「戻れなくなること」は**別の現象**であり、
   分けて教えたほうが正確かつ学びが深い。

---

## Sources

- [Maximum CPU — Amazon Aurora (Performance Insights)](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.Overview.MaxCPU.html)
- [Overview of the Performance Insights dashboard](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.UsingDashboard.Components.html)
- [Managing performance and scaling for Amazon Aurora MySQL (max_connections 表)](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Performance.html)
- [Hardware specifications for DB instance classes for Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.DBInstanceClass.Summary.html)
- [RDS Proxy concepts and terminology](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/rds-proxy.howitworks.html)
- [RDS Proxy — Configuration guidelines](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/rds-proxy-best-practices.configuration.html)
- [Connection management and pooling — Aurora MySQL DBA Handbook](https://docs.aws.amazon.com/whitepapers/latest/amazon-aurora-mysql-db-admin-handbook/connection-management-and-pooling.html)
- [Kingman's formula — Wikipedia](https://en.wikipedia.org/wiki/Kingman%27s_formula)
- [Metastable Failures in Distributed Systems (Bronson et al., HotOS'21)](https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf)
- [Metastable Failures in the Wild (USENIX ;login:)](https://www.usenix.org/publications/loginonline/metastable-failures-wild)
- [Marc Brooker — Metastability and Distributed Systems](https://brooker.co.za/blog/2021/05/24/metastable.html)
- [Scalability Modeling using Universal Scalability Law (WSO2)](https://wso2.com/blog/research/scalability-modeling-using-universal-scalability-law/)

## 検証に使ったスクリプト

本文の実測値は、モデル候補を 3 回作り直して得たもの。
最終版のロジックは §4-2 の更新式そのままで、`test/` 実装時の参照とする。
（v1 で「流体だけでは ρ<1 の待ち時間が 0」、v2 で「統計項のクランプ漏れ」「USL の二重計上」を発見）
