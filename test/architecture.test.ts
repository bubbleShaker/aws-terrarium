import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * アーキテクチャ適合テスト。
 *
 * PLAN.md で「Core 層は three.js も React も知らない」と決めた。
 * 口約束のままだと必ず破られるので、テストで守る。
 * これが落ちたら「便利だから」と View の都合を Core に持ち込んでいるということ。
 */
const CORE_DIR = fileURLToPath(new URL('../src/core', import.meta.url));

const FORBIDDEN_IN_CORE = [
  // View 層のライブラリ
  'three',
  'react',
  'react-dom',
  '@react-three/fiber',
  '@react-three/drei',
  // I/O。Core は純粋な計算だけを担う
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node:http',
  'node:https',
  'node:net',
  'node:process',
  'fs',
  'child_process',
];

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) return collectTsFiles(fullPath);
      return entry.name.endsWith('.ts') ? [fullPath] : [];
    }),
  );
  return files.flat();
}

/** `import ... from 'x'` / `import('x')` の 'x' を拾う。 */
function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*export\s+(?:[^'"]*?\s+from\s+)\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe('Core 層の独立性', () => {
  it('src/core は View 層のライブラリを一切 import していない', async () => {
    const files = await collectTsFiles(CORE_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const specifier of extractImportSpecifiers(source)) {
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (packageName !== undefined && FORBIDDEN_IN_CORE.includes(packageName)) {
          violations.push(`${relative(CORE_DIR, file)} → ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('src/core は I/O を持たない（console / process / DOM グローバル）', async () => {
    // import だけ見ていてもグローバル経由の I/O は素通りする。
    // CLI を src/core に置いてしまった実績があるので、識別子レベルでも塞ぐ。
    const forbiddenGlobals = [
      /\bconsole\s*\./,
      /\bprocess\s*\./,
      /\bdocument\s*\./,
      /\bwindow\s*\./,
      /\blocalStorage\b/,
      /\bfetch\s*\(/,
    ];

    const files = await collectTsFiles(CORE_DIR);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      // 行コメント・ブロックコメントは対象外にする（解説文に単語が出てくるため）。
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const pattern of forbiddenGlobals) {
        if (pattern.test(code)) {
          violations.push(`${relative(CORE_DIR, file)} → ${pattern.source}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('src/core は View 層 (src/view) を import していない', async () => {
    const files = await collectTsFiles(CORE_DIR);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const specifier of extractImportSpecifiers(source)) {
        if (specifier.includes('/view/') || specifier.endsWith('/view')) {
          violations.push(`${relative(CORE_DIR, file)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
