#!/usr/bin/env node
/**
 * kch-ai 스킬 설치: 이 PC에 한 벌만 두고(~/.kch-ai/skill), Codex · Claude Code · Aside 가
 * 모두 그 한 벌을 보도록 연결합니다. 다시 실행하면 최신본으로 바뀝니다(업데이트도 같은 방법).
 * 문의: lee90@kchglobal.co.kr
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL = join(HOME, '.kch-ai', 'skill');
const LINK_NAME = 'kch-ai';

const isOurs = (dir) => {
  try {
    return /^name:\s*kch-ai\s*$/m.test(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
  } catch {
    return false;
  }
};
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
/** Removes a link without touching what it points to (Windows junctions need rmdir). */
function removeLink(path) {
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path);
  }
}

if (!isOurs(SOURCE)) {
  console.error('이 파일은 kch-ai 스킬 저장소의 scripts 폴더 안에서 실행해야 합니다.');
  process.exit(1);
}

// 1) One copy on this PC.
if (real(SOURCE) !== real(CANONICAL)) {
  if (existsSync(CANONICAL) && !isLink(CANONICAL) && !isOurs(CANONICAL)) {
    console.error(`${CANONICAL} 에 다른 파일이 있어 멈췄습니다. 확인 후 다시 실행해 주세요.`);
    process.exit(1);
  }
  if (isLink(CANONICAL)) removeLink(CANONICAL);
  else rmSync(CANONICAL, { recursive: true, force: true });
  mkdirSync(dirname(CANONICAL), { recursive: true });
  cpSync(SOURCE, CANONICAL, { recursive: true, filter: (path) => basename(path) !== '.git' });
}

// 2) Every AI tool on this PC looks at that one copy.
const targets = [
  { tool: 'Codex', dir: join(process.env.CODEX_HOME || join(HOME, '.codex'), 'skills') },
  { tool: 'Claude Code', dir: join(HOME, '.claude', 'skills') },
];
const asideRoot = join(HOME, '.aside', 'u');
if (existsSync(asideRoot)) {
  for (const account of readdirSync(asideRoot)) {
    if (existsSync(join(asideRoot, account, 'skills'))) targets.push({ tool: 'Aside', dir: join(asideRoot, account, 'skills', 'user') });
  }
}

const results = [];
for (const target of targets) {
  mkdirSync(target.dir, { recursive: true });
  // Earlier copies of this skill under any name (e.g. kch-ai-skill) are replaced by the single link.
  for (const name of readdirSync(target.dir)) {
    const path = join(target.dir, name);
    if (name === LINK_NAME) continue;
    if (isLink(path) ? real(path) === real(CANONICAL) : isOurs(path)) {
      if (isLink(path)) removeLink(path);
      else rmSync(path, { recursive: true, force: true });
    }
  }
  const linkPath = join(target.dir, LINK_NAME);
  if (isLink(linkPath)) removeLink(linkPath);
  else if (existsSync(linkPath)) {
    if (!isOurs(linkPath)) {
      results.push(`${target.tool}: ${linkPath} 에 다른 스킬이 있어 건너뜀`);
      continue;
    }
    rmSync(linkPath, { recursive: true, force: true });
  }
  try {
    symlinkSync(CANONICAL, linkPath, platform() === 'win32' ? 'junction' : 'dir');
    results.push(`${target.tool}: 연결 (${linkPath})`);
  } catch {
    cpSync(CANONICAL, linkPath, { recursive: true });
    results.push(`${target.tool}: 복사 (${linkPath}, 업데이트 때 다시 실행 필요)`);
  }
}

const version = /const VERSION = '([^']+)'/.exec(readFileSync(join(CANONICAL, 'scripts', 'kch-ai.mjs'), 'utf8'))?.[1] ?? '?';
console.log(`kch-ai 스킬 ${version} 설치: ${CANONICAL}`);
for (const line of results) console.log(`  ${line}`);
console.log('AI 앱(Codex, Claude Code 등)을 다시 시작하면 바로 쓸 수 있습니다.');
