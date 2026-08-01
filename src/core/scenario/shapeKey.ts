/**
 * 設定の「形」を表す文字列を作る。
 *
 * 各セッションは「この変更はモデルを作り直す必要があるか」を判断しなければならない。
 * 判断を設定項目の列挙で書くと、**あとで項目を足したときに追加を忘れて**
 * 「変えたのに反映されない」という気づきにくいバグを生む。
 *
 * そこで**設定を丸ごと鍵にし、作り直さなくてよい項目だけを除外する**書き方に統一する。
 * 忘れたときの挙動が「余計に作り直す」（安全側）に倒れる。
 */

/**
 * キーの順序に依存しない JSON 文字列化。
 *
 * 素の `JSON.stringify` はプロパティの定義順で結果が変わるため、
 * 同じ内容の設定でもオブジェクトの組み立て方が違うと別物と判定されてしまう。
 */
export function stableStringify(value: unknown): string {
  // JSON.stringify は NaN も Infinity も "null" にしてしまい、別の設定が同じ鍵になる。
  if (typeof value === 'number' && !Number.isFinite(value)) return `#${String(value)}`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
