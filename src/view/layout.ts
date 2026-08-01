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
/** 負荷の源のパイプが 2 つへ分かれる高さ。ここから下は左右別々の話になる。 */
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
// 2 つの敷地を 1 つの空間へ並べる
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

/**
 * DynamoDB と Aurora の敷地の中心。**原点を空けて左右に置く**。
 *
 * 原点を空けているのは、そこに負荷の源のパイプを立てるため。
 * 「1 本のパイプが 2 つへ分岐する」が空間として実在していることが、
 * 「同じ負荷を流している」を HUD 上の約束事ではなく**目に見える事実**にしている
 * （PLAN.md「M3 の空間設計」1 の決め手そのもの）。
 */
export function siteOrigins(
  partitionCount: number,
  maxConnections: number,
): { dynamodb: SitePosition; aurora: SitePosition } {
  const separation = siteSeparation(partitionCount, maxConnections);
  return {
    dynamodb: { x: -separation / 2, z: 0 },
    aurora: { x: separation / 2, z: 0 },
  };
}

/** 敷地の中心どうしの距離。互いの縁が必ず `SITE_GAP` だけ離れる。 */
export function siteSeparation(partitionCount: number, maxConnections: number): number {
  return gridWidth(partitionCount) / 2 + auroraSiteMetrics(maxConnections).width / 2 + SITE_GAP;
}

/**
 * 空間全体のおおよその半幅。カメラの初期距離を決めるのに使う。
 *
 * ⚠️ **両方が初期画角に収まる**ことが M3 の完了条件そのものである。
 * 片方が枠外にあると、そもそも並置になっていない。
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

// ────────────────────────────────────────────────────────────────
// 粒子の縮尺（両サービス共通）
// ────────────────────────────────────────────────────────────────

/** 1 サービスあたりに描く粒子の上限。両者に同じ予算を与える。 */
export const PARTICLE_BUDGET = 480;
/** 縮尺を量子化する梯子。1-2-5 の刻みは目盛りの慣習に合わせてある。 */
const SCALE_MANTISSAS = [1, 2, 5];

/**
 * 粒子 1 個が表すリクエストレート (件/秒)。
 *
 * ## なぜ共有の負荷から決めるのか
 *
 * 縮尺を両サービスで揃えないと「同じ負荷を流している」が目で見えなくなる。
 * 負荷ダイヤルは 1 本しかない (`TerrariumDriver`) ので、
 * **その 1 本から縮尺を導けば両者が一致することは構造的に保証される** —
 * サービスごとに縮尺を持たせて「揃えるのを忘れない」と決意するより確実である。
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
