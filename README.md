# aws-terrarium

> テラリウム = ガラス容器の中の小さな生態系。
> クラウドを箱庭として外から観察し、負荷をかけて反応を見る。

AWS の主要サービスを**ブラウザ内エミュレータ**として再現し、
**three.js のバーチャル空間**を歩きながら負荷をかけて挙動を体感する学習アプリ。

実 AWS アカウントは不要。GitHub Pages で動く。

## なぜエミュレータなのか

「過度なトラフィックで DynamoDB と RDS の違いを体感したい」——
これを実 AWS でやると学習が成立しない。費用がかかり、結果が毎回揺れ、
そして何より **どのパーティションが詰まったのかが見えない**（CloudWatch は集計値しか返さない）。

ホットパーティションも writer 単独制約もスロットリングも、すべてモデル化できる決定論的な現象である。
ダイヤルを回した瞬間に結果が返り、詰まった箇所が赤く光るほうが、学習効率は圧倒的に高い。

詳しい設計判断は [PLAN.md](./PLAN.md) を参照。

## 一番伝えたいこと

**DynamoDB はうるさく壊れ、Aurora は静かに壊れる。**

| | DynamoDB | Aurora writer |
|---|---|---|
| 限界に達したとき | **拒否する**（スロットル） | **待たせる**（待ち行列） |
| 症状 | エラー率が上がる。レイテンシは低いまま | エラーは出ない。レイテンシだけが指数的に伸びる |
| 気づきやすさ | 気づきやすい | **気づきにくい**（動いてはいる） |

この非対称性が両者の設計思想の差そのもの。本プロジェクトの背骨。

## 対象サービス

EC2 / ECS / Fargate / SQS / Aurora RDS / DynamoDB / SNS /
CloudFront / Lambda / EventBridge / EFS / S3 / Step Functions

## 状態

M2 まで完了。**DynamoDB を 3D 空間で動かせる**（負荷ダイヤル・キー分布の切り替え・
アダプティブキャパシティの ON/OFF）。次は M3（Aurora を並置して壊れ方の違いを見せる）。
進捗は [PLAN.md](./PLAN.md) のマイルストーン表を参照。

`npm run dev` を開いて `single-hot-key` プリセットを選ぶと、
**41 本のうち 1 本だけが物理上限の面を突き抜けて赤熱し、頂上でリクエストが赤く弾け散る**。
テーブルには 40,000 WCU 積んであるのに、である。

## 開発

```bash
npm install
npm run dev        # 3D ビューを開発サーバーで起動
npm test           # Core 層の単体テスト (107 件)
npm run typecheck  # Core と View を別々の tsconfig で型検査
npm run scenario   # CLI でシナリオを走らせて結果を表示 (3D 抜き)
npm run build      # 静的ビルド
```

## ディレクトリ

```
src/core/      純粋 TypeScript のシミュレーションエンジン (three.js も React も知らない)
src/view/      React Three Fiber の 3D 表現 (M2 以降)
research/      調査メモ
summary/       実装完了時のまとめ
knowledge/     詰まった点とその解説
```

## ライセンス

MIT
