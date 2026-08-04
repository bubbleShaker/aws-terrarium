/**
 * 空間の配置と寸法。**three.js に依存しない純粋な計算だけ**を置く。
 *
 * 色 (three.js の Color が要る) は palette.ts に分けてある。
 * 分けているのは、柱の高さの写し方のような「教材の主張そのもの」を担う関数を、
 * ブラウザ抜きの単体テストで固定できるようにするため。
 */

export const COLUMN_SPACING = 1.5;
export const COLUMN_WIDTH = 0.86;
/** 内側（受理された量）の柱の太さ。外側の半透明な柱の中に収まる。 */
export const ACCEPTED_WIDTH = 0.5;
/** 需要が物理上限ちょうどのときの柱の高さ。この高さに基準面を張る。 */
export const HEIGHT_AT_HARD_CAP = 2;
/** 粒子が降ってくる高さ。クライアント側を表す。 */
export const SOURCE_HEIGHT = 6.5;
/** 負荷の源のパイプが各サービスへ分かれる高さ。ここから下は敷地ごと別々の話になる。 */
export const SPLIT_HEIGHT = 8.2;
/** パイプの立ち上がりの頂点。**初期画角に入る高さ**であること（分岐が見えないと並置の前提が伝わらない）。 */
export const PIPE_TOP = 9.2;
/** 柱が数本しかないときでもカメラが引く距離の下限。 */
const MIN_GRID_EXTENT = 6;

/** 敷地の中心。パイプの分岐先。 */
export interface SitePosition {
  readonly x: number;
  readonly z: number;
}

/** 柱を格子状に並べたときの位置。パーティション数が変わると並びも変わる。 */
export function gridPositions(count: number): { x: number; z: number }[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return Array.from({ length: count }, (_, i) => ({
    x: ((i % cols) - (cols - 1) / 2) * COLUMN_SPACING,
    z: (Math.floor(i / cols) - (rows - 1) / 2) * COLUMN_SPACING,
  }));
}

/** 格子が実際に占める一辺の長さ。DynamoDB 側の敷地の幅そのもの。 */
export function gridWidth(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count))) * COLUMN_SPACING;
}

/** 格子全体のおおよその一辺。カメラの初期距離を決めるのに使う。 */
export function gridExtent(count: number): number {
  // 下限を設けているのは、パーティションが 1 本しかないテーブル (big-item-trap) で
  // カメラが柱に貼りつき、頂上が画角から外れるのを防ぐため。
  return Math.max(MIN_GRID_EXTENT, Math.ceil(Math.sqrt(count)) * COLUMN_SPACING);
}

/**
 * 上限超過ぶんの圧縮の強さ。1 で素の log2、小さいほど強く潰す。
 * 単一ホットキー (上限の 27 倍) の柱が、初期カメラの画角に収まる値にしてある。
 */
const OVERFLOW_COMPRESSION = 0.6;

/**
 * 需要 (units/秒) を柱の高さに変換する。
 *
 * 物理上限までは線形、超えた分は対数で圧縮する。
 * 単一ホットキーでは需要が上限の 27 倍に達するので、
 * 線形のままだと柱が画面外に飛び出して「他の柱との比較」ができなくなる。
 * 上限を境に伸び方が変わることで、「壁を越えている」こと自体も形で分かる。
 */
export function columnHeight(unitsPerSec: number, hardCapUnitsPerSec: number): number {
  if (hardCapUnitsPerSec <= 0 || unitsPerSec <= 0) return 0;
  const ratio = unitsPerSec / hardCapUnitsPerSec;
  if (ratio <= 1) return ratio * HEIGHT_AT_HARD_CAP;
  return HEIGHT_AT_HARD_CAP * (1 + Math.log2(ratio) * OVERFLOW_COMPRESSION);
}

/** 指数的な追従。フレーム時間に依存せず同じ速さで滑らかになる。 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

// ────────────────────────────────────────────────────────────────
// Aurora の設備
// ────────────────────────────────────────────────────────────────

export const WRITER_WIDTH = 2.8;
export const WRITER_DEPTH = 1.6;
export const WRITER_HEIGHT = 1.8;
/** 待合室と writer の間の通路。 */
const ROOM_MARGIN = 0.6;
/** 席の間隔。 */
export const SEAT_SPACING = 0.24;

/**
 * 席 1 個が表すリクエスト件数。
 *
 * ⚠️ **流れの縮尺 (`requestsPerParticle`) とはわざと別にしてある。**
 * 席が表すのは待ち行列長 Q という**ストック (件)** で、
 * 粒子が表すのは到着レート (件/秒) — 単位が違うので同じ縮尺には乗らない。
 *
 * 無理に揃えると、どちらかが必ず読めなくなる。
 * 共通の縮尺で 1,000 件を描こうとすると席が 7 個にしかならず
 * 「待合室 1,000 席」が消えるし、席に合わせて流れを刻むと粒子が数千個になる。
 *
 * 席と粒子は Little の法則の両辺 — 席が **L**（何人並んでいるか）、
 * 粒子が待合室を横断する時間が **W**（1 人がどれだけ待つか）— を分担している。
 */
export const REQUESTS_PER_SEAT = 10;

/** 待合室に敷く席の数。`max_connections` をそのまま縮尺で割る。 */
export function seatCount(maxConnections: number): number {
  if (!Number.isFinite(maxConnections) || maxConnections <= 0) return 0;
  return Math.ceil(maxConnections / REQUESTS_PER_SEAT);
}

/**
 * 席を正方形に近い格子へ並べたときの位置（待合室の中心が原点）。
 *
 * 正方形にしているのは、インスタンスクラスを上げたとき
 * **待合室が縦にも横にも広がる**ようにするため。
 * 一方向にだけ伸ばすと、4 倍になったことが面積として読めない。
 */
export function seatPositions(maxConnections: number): { x: number; z: number }[] {
  const count = seatCount(maxConnections);
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return Array.from({ length: count }, (_, i) => ({
    x: ((i % cols) - (cols - 1) / 2) * SEAT_SPACING,
    // 席番号 0 が writer 側 (-z)。若い順に埋めると、行列は窓口を先頭にして
    // 入口 (+z) 側へ伸びていく — 「writer の手前で詰まる」向きになる。
    z: (Math.floor(i / cols) - (rows - 1) / 2) * SEAT_SPACING,
  }));
}

export function roomWidth(maxConnections: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(seatCount(maxConnections)))) * SEAT_SPACING;
}

export function roomDepth(maxConnections: number): number {
  const count = seatCount(maxConnections);
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  return Math.max(1, Math.ceil(count / cols)) * SEAT_SPACING;
}

/** Aurora の設備一式の寸法。敷地の中心を原点とした前後の位置を返す。 */
export interface AuroraSiteMetrics {
  readonly width: number;
  readonly depth: number;
  /** writer 本体の中心 z。奥に置く。 */
  readonly writerZ: number;
  /** vCPU の窓口が並ぶ z。writer の手前の面。 */
  readonly gateZ: number;
  /** 待合室の中心 z。 */
  readonly roomZ: number;
  /** 待合室の入口 z。粒子はここへ降ってきて、-z 方向へ列を進む。 */
  readonly entranceZ: number;
  readonly roomWidth: number;
  readonly roomDepth: number;
}

/**
 * Aurora の敷地の寸法。**`max_connections` で待合室の面積が決まる**。
 *
 * 窓口 (vCPU) は writer の前面に本数だけ増えて幅は変わらないのに対し、
 * 待合室は面積ごと広がる。db.r6g.large の窓口 2 に対する席 100 個という寸法差が、
 * 「並ぶ場所が捌ける本数の 500 倍広い」をそのまま語る。
 *
 * ⚠️ 主題は**どのクラスでも桁が違う**ことであって、「上げるほど待合室ばかり増える」ではない
 * （実際は窓口 16 倍に対し待合室 5 倍で、比は 500 倍 → 156 倍へ縮まる）。
 */
export function auroraSiteMetrics(maxConnections: number): AuroraSiteMetrics {
  const rw = roomWidth(maxConnections);
  const rd = roomDepth(maxConnections);
  const depth = WRITER_DEPTH + ROOM_MARGIN + rd;
  const writerZ = -depth / 2 + WRITER_DEPTH / 2;
  return {
    width: Math.max(WRITER_WIDTH, rw),
    depth,
    writerZ,
    gateZ: writerZ + WRITER_DEPTH / 2,
    roomZ: depth / 2 - rd / 2,
    entranceZ: depth / 2,
    roomWidth: rw,
    roomDepth: rd,
  };
}

/** vCPU の窓口が writer の前面に並ぶ x。**窓口の本数がそのまま壁A**。 */
export function vcpuGatePositions(vcpu: number): number[] {
  const count = Math.max(1, Math.floor(vcpu));
  const span = WRITER_WIDTH * 0.86;
  return Array.from({ length: count }, (_, i) => ((i + 0.5) / count - 0.5) * span);
}

// ────────────────────────────────────────────────────────────────
// SQS のレーン
// ────────────────────────────────────────────────────────────────

/**
 * ⚠️ **Aurora の「席」を流用してはいけない**（M4-2 の壁 2）。
 *
 * 席が表しているのは `max_connections` という**有限の器**である。
 * SQS のキューは無制限で、**器が無いことが主張そのもの**なので、
 * 同じ縮尺 (`REQUESTS_PER_SEAT`) を当てるとバックログ 30,000 件で
 * 待合室の一辺が 13.2（Aurora の 2.4 に対し 5.5 倍）になり、60 秒で隣の敷地へめり込む。
 *
 * 代わりに**奥へ流れる 1 本のレーン**で描く。
 * consumer 側（列の先頭）を手前に固定し、尾だけが奥 (-z) へ伸びる:
 *
 * - 伸びるほどカメラから遠ざかるので、**どれだけ溜まっても画角を破らない**
 * - 奥は霧なので、**端が無いこと**が形で出る（器が無い、を絵にする唯一の方法）
 * - 期限切れで消えるのは**最古＝先頭**なので、消える瞬間は手前でよく見える
 */

/** レーンの幅。 */
export const LANE_WIDTH = 1.6;
/** consumer の設備（列の先頭に立つ窓口）の寸法。 */
export const CONSUMER_BANK_WIDTH = 1.8;
export const CONSUMER_BANK_DEPTH = 0.9;
export const CONSUMER_BANK_HEIGHT = 0.7;

/**
 * 対数の膝の位置 (件)。ここまではほぼ件数に比例し、その先はなだらかに寝る。
 * ⚠️ **境目ではない**（下の doc を見ること）。曲線はここでも滑らかに続いている。
 */
const LANE_KNEE_MESSAGES = 160;
/**
 * レーンの伸びの速さ。1,000 件で長さ 3、
 * 保持 4 日 × 500 q/s の理論上限 1.7 億件でも 21 に収まる値。
 */
const LANE_LENGTH_SCALE = 1.514;

/**
 * バックログ (件) をレーンの長さに変換する。
 *
 * ## ⚠️ 柱と違って、どこにも折れ目を作らない
 *
 * `columnHeight` は「物理上限までは線形、超えたら対数」と**わざと折る**。
 * 折れ目が壁の在り処そのものを語るからである。
 *
 * **SQS に壁は無い。だから折れ目があってはいけない。**
 * 同じ二段構えを流用すると、切り替え点に「ここで何かが起きた」という
 * 読み方が生まれる — それは `columnHeight` が正しく語っているのと同じ読み方であり、
 * ここでは嘘になる。実際、線形と対数を継ぐと境目で伸び率が半分に跳ね、
 * 柱の折れ（0.87 倍）より 2 倍鋭い折れができてしまう。
 *
 * そこで単調で滑らかな 1 本の曲線にしてある。
 * 目盛りが寝ていくのは「絵に収めるため」だけで、**どの点も他の点と同じ資格**である。
 */
export function backlogLaneLength(messages: number): number {
  if (!Number.isFinite(messages) || messages <= 0) return 0;
  // log1p を使うのは、件数が少ないとき (1 件〜) の精度を落とさないため。
  return LANE_LENGTH_SCALE * Math.log1p(messages / LANE_KNEE_MESSAGES);
}

/**
 * 最古メッセージの年齢を、**レーンとは直交する縦棒の高さ**に変換する。
 *
 * ## なぜ別の軸なのか
 *
 * M4 の看板は「**長さが減っているのに年齢は伸びる**」である
 * （負荷を安全域へ下げた直後、先頭はまだ過負荷の層に居るので年齢は伸び続ける。
 * PLAN.md「M4-1 の実装で分かったこと」1）。
 * 年齢をレーンの長さや色に乗せると、この主役の現象が**同じ軸に潰れて消える**。
 *
 * ## なぜ保持期間に対する比なのか
 *
 * 100% で `HEIGHT_AT_HARD_CAP` — **DynamoDB の物理上限の基準面と同じ高さ**に壁が来る。
 * 3 つの敷地で「この高さが壁」が揃う。
 *
 * ⚠️ ただし柱は突き抜けるが、この棒は**決して突き抜けない**。
 * 年齢が保持期間を超えたメッセージはもう存在しないからである。
 * 頭打ちになること自体が SQS の性質（壁に達したら、越えずに消える）。
 */
export function ageBarHeight(ageSeconds: number, retentionSeconds: number): number {
  if (!Number.isFinite(ageSeconds) || ageSeconds <= 0) return 0;
  if (!Number.isFinite(retentionSeconds) || retentionSeconds <= 0) return 0;
  return Math.min(1, ageSeconds / retentionSeconds) * HEIGHT_AT_HARD_CAP;
}

/** 年齢の縦棒を立てる x。レーンの脇（列に重ねない）。 */
export const AGE_BAR_OFFSET_X = LANE_WIDTH / 2 + 0.45;
/** 年齢の縦棒の太さ。敷地の幅を勘定するのに要る。 */
export const AGE_BAR_WIDTH = 0.22;

/** SQS の敷地の寸法。**敷地の原点は consumer の設備**（列の先頭）に置く。 */
export interface SqsSiteMetrics {
  /**
   * 敷地の幅。**構成物を全部包む**（`auroraSiteMetrics.width` と同じ契約）。
   * 年齢の縦棒はレーンの外に立つので、レーンの幅ではなくそちらが幅を決める。
   */
  readonly width: number;
  /** 現在のバックログでのレーンの長さ。 */
  readonly laneLength: number;
  /** 列の先頭の z。consumer の設備のすぐ奥の面。**ここで捌かれ、ここで期限切れが起きる**。 */
  readonly headZ: number;
  /** 列の尾の z。バックログが伸びるほど奥 (-z) へ下がる。 */
  readonly tailZ: number;
  /** レーンの中心 z。 */
  readonly laneZ: number;
}

/**
 * SQS の敷地の寸法。**バックログの件数だけで決まる**。
 *
 * ⚠️ 消化レート (consumer 数) は一切入らない。キューに残っているのは
 * 保持期間ぶんの到着量そのもので、**消化レートは 1 ミリも効かない**
 * （PLAN.md「M4-1 の実装で分かったこと」2）。
 * ここに consumer 数を混ぜると、その発見が絵の上で嘘になる。
 */
export function sqsSiteMetrics(backlogMessages: number): SqsSiteMetrics {
  const laneLength = backlogLaneLength(backlogMessages);
  const headZ = -CONSUMER_BANK_DEPTH / 2;
  return {
    // 年齢の縦棒 (`AGE_BAR_OFFSET_X`) まで含めて包む。ここを狭く申告すると、
    // 敷地の重なりを見ているテストが**実際より細い箱**で判定することになる。
    width: Math.max(CONSUMER_BANK_WIDTH, LANE_WIDTH, 2 * AGE_BAR_OFFSET_X + AGE_BAR_WIDTH),
    laneLength,
    headZ,
    tailZ: headZ - laneLength,
    laneZ: headZ - laneLength / 2,
  };
}

// ────────────────────────────────────────────────────────────────
// 3 つの敷地を 1 つの空間へ並べる
// ────────────────────────────────────────────────────────────────

/** 敷地と敷地の間に空ける距離。ここをパイプの分岐が跨ぐ。 */
const SITE_GAP = 9;
/**
 * 敷地が小さくてもカメラが寄りすぎない下限。
 *
 * 効いているのは横幅ではなく**縦**である。敷地が狭くても、収めたいものは
 * 地面から `PIPE_TOP` まで縦に長い。ここを下げると分岐のパイプが画角の上へ抜け、
 * 「1 本の負荷が 2 つへ分かれている」が見えなくなる
 * （`test/viewLayout.test.ts` が縦の収まりを固定している）。
 */
const MIN_TERRARIUM_EXTENT = 8;

/** SQS の設備と、手前の 2 敷地の奥の縁との間に空ける距離。 */
const SQS_FRONT_CLEARANCE = 1.5;

/**
 * SQS の敷地を、手前の 2 敷地より奥へ引く距離。
 *
 * 手前の敷地の**奥行きの半分**を基準にしている。x 方向では既に十分離れているので
 * （左右の敷地は `separation/2` だけ外に居る）、この距離が担っているのは
 * 重なりの回避ではなく「**3 つが別々の場所として読める**」ことのほうである。
 *
 * ⚠️ 大きくしすぎると SQS がカメラから遠ざかって霧に沈む。
 * ここを触ったら `fogRange` の検査（最奥の敷地が霧に沈まない）も必ず見ること。
 */
export function sqsSetback(partitionCount: number, maxConnections: number): number {
  const frontHalfDepth = Math.max(
    // 格子の奥行きは `gridWidth` で代用している。`ceil(sqrt(n))` の格子は
    // 常に 奥行き ≤ 幅 なので安全側にずれる（`gridDepth` は用意していない）。
    gridWidth(partitionCount) / 2,
    auroraSiteMetrics(maxConnections).depth / 2,
  );
  return frontHalfDepth + CONSUMER_BANK_DEPTH / 2 + SQS_FRONT_CLEARANCE;
}

/**
 * 3 つの敷地の中心。**原点を空けて、左右と中央奥に置く**（弓なり配置）。
 *
 * ```
 *               [SQS]        ← 中央奥 (-z)
 *                  ╲
 *    [DynamoDB] ─── ▮ ─── [Aurora]
 *                 パイプ
 * ```
 *
 * 原点を空けているのは、そこに負荷の源のパイプを立てるため。
 * 「1 本のパイプが 3 つへ分岐する」が空間として実在していることが、
 * 「同じ負荷を流している」を HUD 上の約束事ではなく**目に見える事実**にしている
 * （PLAN.md「M3 の空間設計」1 の決め手そのもの）。
 *
 * ## なぜ 3 つ目を横一列に足さないのか（M4-2 の壁 1）
 *
 * カメラ距離は横と縦の厳しいほうから逆算しているが、**現状は全ケースで横が支配**している。
 * 横一列にすると距離が 21.7 → 35.0（最大時 58.3）へ伸び、画面内の物が 6 割の大きさになって、
 * M2 の「柱 1 本が赤熱する」も M3 の「席は空いていないのに床は赤い」も読めなくなる。
 *
 * 奥へ引けば**横幅が増えないのでカメラ距離は変わらない**。
 * 三角配置も extent は小さいが、カメラの向き `[0.15, 0.32, 0.94]` がほぼ正面なので
 * 3 つ目が真後ろに来て向きの変更を強いられ、「左に DynamoDB / 右に Aurora」が崩れる。
 * 弓なりなら向きに触らずに済む。
 */
export function siteOrigins(
  partitionCount: number,
  maxConnections: number,
): { dynamodb: SitePosition; aurora: SitePosition; sqs: SitePosition } {
  const separation = siteSeparation(partitionCount, maxConnections);
  return {
    dynamodb: { x: -separation / 2, z: 0 },
    aurora: { x: separation / 2, z: 0 },
    // x=0 の地面付近は空いている（パイプは `SPLIT_HEIGHT` より上にしか無い）ので、
    // 中央奥へ置いても手前の敷地に隠れない。
    sqs: { x: 0, z: -sqsSetback(partitionCount, maxConnections) },
  };
}

/** 敷地の中心どうしの距離。互いの縁が必ず `SITE_GAP` だけ離れる。 */
export function siteSeparation(partitionCount: number, maxConnections: number): number {
  return gridWidth(partitionCount) / 2 + auroraSiteMetrics(maxConnections).width / 2 + SITE_GAP;
}

/**
 * 空間全体のおおよその半幅。カメラの初期距離を決めるのに使う。
 *
 * ⚠️ **3 つとも初期画角に収まる**ことが M3 / M4-2 の完了条件そのものである。
 * 1 つでも枠外にあると、そもそも並置になっていない。
 *
 * ⚠️ **SQS はここに入らない**。x=0 に幅 1.8 で立っているだけなので、
 * 左右の敷地の内側に完全に収まり、半幅を 1 ミリも押し広げない。
 * それが弓なり配置を選んだ理由そのもの — 3 つ目を足してもカメラが引かない
 * （`test/viewLayout.test.ts` がこの等式を固定している）。
 */
export function terrariumExtent(partitionCount: number, maxConnections: number): number {
  const separation = siteSeparation(partitionCount, maxConnections);
  const widest = Math.max(gridWidth(partitionCount), auroraSiteMetrics(maxConnections).width);
  return Math.max(MIN_TERRARIUM_EXTENT, separation / 2 + widest / 2);
}

/**
 * カメラが向く高さ。**地面ではなく空間の真ん中**を見る。
 *
 * 収めたいものが地面から `PIPE_TOP` まで縦に長いので、
 * 原点付近を向くと分岐のパイプが画角の上へ抜ける。
 */
export const CAMERA_TARGET_HEIGHT = 3.2;

/** カメラの画角 (度)。`TerrariumScene` の `fov` と同じ値であること。 */
export const CAMERA_FOV_DEGREES = 45;
/** 画角の計算に使う想定アスペクト比。テストが同じ値で検算する。 */
export const ASSUMED_ASPECT = 16 / 9;

/**
 * 画角のうち、左右のパネルに隠されずに**実際に見える横幅**の割合。
 *
 * ⚠️ これを勘定に入れないと、パネルが両側に立っている画面で
 * Aurora の待合室がコントロールパネルの下に潜る。
 * 「両方が初期画角に収まる」は**パネルを除いた帯の中で**成り立つ必要がある。
 *
 * 0.5 が成り立つ前提は `styles.css` の rail 幅である
 * （330px × 2 + 余白 = 724px なら 1,448px 以上の画面で成立）。
 * 狭い画面では rail 側を 280px へ詰めて前提を保っている。両者は連動しているので、
 * 片方を変えるときはもう片方も見ること。
 */
export const VISIBLE_WIDTH_FRACTION = 0.5;

/**
 * カメラの初期位置。**距離は目分量ではなく要件から逆算する**。
 *
 * 満たすべき条件が 2 つあり、厳しいほうが距離を決める:
 *
 * - **横**: 2 つの敷地が、左右のパネルに隠れない帯の中へ収まること
 * - **縦**: 地面から分岐のパイプ (`PIPE_TOP`) までが収まること
 *
 * 係数を手で決めていたときは、パーティション数や `max_connections` を変えた瞬間に
 * どちらかが破綻した（実際、待合室がパネルの下に潜った）。
 *
 * 向きは正面寄りにしてある。M2 までは格子を斜めから見下ろしていたが、並置では
 * 「左に DynamoDB / 右に Aurora」が一目で分かることのほうが優先される。
 * 真正面にしないのは、待合室の奥行き（列の長さ）が潰れるため。
 */
export function initialCameraPosition(extent: number): [number, number, number] {
  const halfAngle = Math.tan((CAMERA_FOV_DEGREES / 2) * (Math.PI / 180));
  const forWidth = extent / (halfAngle * ASSUMED_ASPECT * VISIBLE_WIDTH_FRACTION);
  const forHeight =
    Math.max(PIPE_TOP - CAMERA_TARGET_HEIGHT, CAMERA_TARGET_HEIGHT) / halfAngle;
  const distance = Math.max(forWidth, forHeight);

  // 注視点から見た向き。正規化してあるので、係数を触っても距離の意味が変わらない。
  const [dx, dy, dz] = [0.15, 0.32, 0.94];
  const length = Math.hypot(dx, dy, dz);
  return [
    (dx / length) * distance,
    CAMERA_TARGET_HEIGHT + (dy / length) * distance,
    (dz / length) * distance,
  ];
}

/**
 * 初期カメラから、地面のその点までの距離。霧の範囲を決めるのに使う。
 *
 * ⚠️ ユークリッド距離である。three.js の linear fog が実際に使うのは
 * **視線方向の深度**なので、ここの値は常に少し**大きめに出る**。
 * 霧の濃さの見積もりとしては安全側（濃く見積もる）なので上界として正しい。
 */
export function distanceFromInitialCamera(extent: number, point: SitePosition): number {
  const [x, y, z] = initialCameraPosition(extent);
  return Math.hypot(x - point.x, y, z - point.z);
}

/** 最奥の敷地に許す霧の濃さ。これ以上沈むと 3 つ目が背景に溶ける。 */
const MAX_FOG_AT_FARTHEST_SITE = 0.25;

/**
 * 霧の範囲 `[かかり始める距離, 完全に沈む距離]`。
 *
 * ## なぜ計算で出すのか
 *
 * M3 までは `[extent * 1.8, extent * 5]` の決め打ちで足りていた。敷地が 2 つとも
 * z=0 にあり、カメラからの距離がほぼ同じだったからである。
 * SQS を奥へ置いた瞬間にこれが壊れ、**3 つ目だけが 5 割方霧に沈む**（既定プリセットで 0.48）。
 *
 * かかり始める距離は据え置いて、**沈みきる距離だけを押し出す**。
 *
 * ## ⚠️ これは手前の敷地にも効く（避けられない）
 *
 * three.js の fog はシーン全体に一律でかかるので、`far` を押し出すと
 * **手前 2 敷地の霧も一緒に薄くなる**。既定プリセットでの実測:
 *
 * | 敷地の中心 | M3 (`far = 40.0`) | いま (`far = 64.0`) |
 * |---|---|---|
 * | DynamoDB | 0.39 | **0.20** |
 * | Aurora | 0.39 | **0.20** |
 * | SQS | 0.48 | 0.25 |
 *
 * 「奥だけを掬い上げて手前は据え置き」はできない。**空気感は全体に半分薄くなる**。
 * それでも `near` を動かさないほうを選んでいるのは、
 * 霧の立ち上がる位置（どこから奥が霞み始めるか）が空間の奥行き感を作っており、
 * そこを動かすと手前 2 敷地の見え方が「薄くなる」ではなく「別物になる」ため。
 *
 * ⚠️ レーンの尾が霧へ溶けるのは**狙いどおり**（「端が無い」を語るのは霧である）が、
 * その溶け方もこの押し出しで弱まっている。ここで優先して守っているのは尾ではなく、
 * **先頭**（捌かれ、期限切れで消える場所）が読めることのほう。
 * 尾の溶かし方は M4-2b でレーン自身の材質に持たせる（PLAN.md「M4-2b への申し送り」）。
 */
export function fogRange(extent: number, farthestSiteDistance: number): [number, number] {
  // ⚠️ ガードは他の関数と揃える。`far` が NaN になると fog の補間が壊れ、
  // **シーン全体**が破綻する（レーン 1 本が消えるどころの話ではない）。
  if (!Number.isFinite(extent) || extent <= 0) return [0, 1];
  const near = extent * 1.8;
  const beyond = Number.isFinite(farthestSiteDistance)
    ? Math.max(0, farthestSiteDistance - near)
    : 0;
  return [near, Math.max(extent * 5, near + beyond / MAX_FOG_AT_FARTHEST_SITE)];
}

// ────────────────────────────────────────────────────────────────
// 粒子の縮尺（全サービス共通）
// ────────────────────────────────────────────────────────────────

/** 1 サービスあたりに描く粒子の上限。**どのサービスにも同じ予算**を与える。 */
export const PARTICLE_BUDGET = 480;
/** 縮尺を量子化する梯子。1-2-5 の刻みは目盛りの慣習に合わせてある。 */
const SCALE_MANTISSAS = [1, 2, 5];

/**
 * 粒子 1 個が表すリクエストレート (件/秒)。
 *
 * ## なぜ共有の負荷から決めるのか
 *
 * 縮尺を全サービスで揃えないと「同じ負荷を流している」が目で見えなくなる。
 * 負荷ダイヤルは 1 本しかない (`TerrariumDriver`) ので、
 * **その 1 本から縮尺を導けば全部が一致することは構造的に保証される** —
 * サービスごとに縮尺を持たせて「揃えるのを忘れない」と決意するより確実である。
 * サービスが増えるほどこの差は効く（M4 では 3 つ、その先はもっと増える）。
 *
 * ## なぜ固定値にしないのか
 *
 * この画面が扱う負荷は 400 q/s (Aurora の壁) から 60,000 q/s (DynamoDB の壁) まで
 * 150 倍の幅がある。固定の縮尺だと片方の帯域で粒子が 3 個になるか数万個になるかのどちらかになる。
 *
 * 代わりに 1-2-5 の梯子へ量子化してある。ダイヤルを少し動かしただけで
 * 縮尺が跳ねると、粒子の増減が負荷の増減に見えなくなるため。
 */
export function requestsPerParticle(totalRequestsPerSec: number): number {
  if (!Number.isFinite(totalRequestsPerSec) || totalRequestsPerSec <= 0) return 1;
  const raw = totalRequestsPerSec / PARTICLE_BUDGET;
  if (raw <= 1) return 1;
  const exponent = Math.floor(Math.log10(raw));
  for (const mantissa of SCALE_MANTISSAS) {
    const candidate = mantissa * 10 ** exponent;
    if (candidate >= raw) return candidate;
  }
  return 10 ** (exponent + 1);
}

/** その縮尺で実際に描く粒子の本数。予算は超えない。 */
export function particleCount(requestsPerSec: number, requestsPerParticle: number): number {
  if (!Number.isFinite(requestsPerSec) || requestsPerSec <= 0) return 0;
  if (!Number.isFinite(requestsPerParticle) || requestsPerParticle <= 0) return 0;
  return Math.min(PARTICLE_BUDGET, Math.round(requestsPerSec / requestsPerParticle));
}
