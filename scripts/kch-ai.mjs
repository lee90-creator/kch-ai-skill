#!/usr/bin/env node
/**
 * kch-ai: KCH AI 현황관리 스킬의 실행 도구 (의존성 없음, Node.js 18 이상).
 * AI(Codex, Claude Code 등)가 이 파일을 실행해 내 프로젝트를 등록·업데이트합니다.
 * 처음 실행하면 브라우저에 [허용] 화면이 한 번 열립니다. 문의: lee90@kchglobal.co.kr
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '1.2.2';
const DEFAULT_SERVER = 'https://kch-ai-status.kch-lee90.workers.dev';
const CONTACT = 'lee90@kchglobal.co.kr';
const IS_WINDOWS = platform() === 'win32';
const MAX_FILE_BYTES = 20_000_000;

const STAGES = [
  { value: '기획', label: '계획 중', words: ['계획', '계획중', '기획', 'plan', 'planning'] },
  { value: '시제품', label: '개발 중', words: ['개발', '개발중', '시제품', 'dev', 'develop', 'development'] },
  { value: '시범운영', label: 'QA 중', words: ['qa', 'qa중', '테스트', '테스트중', '시범운영', '검증', 'test', 'testing'] },
  { value: '실운영', label: '개발 완료', words: ['완료', '개발완료', '운영', '실운영', 'done', 'complete', 'completed', 'release'] },
];
const MIME_BY_EXT = { '.md': 'text/markdown', '.txt': 'text/markdown', '.log': 'text/markdown', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
const SECRET_PATTERNS = [/sk-[A-Za-z0-9_-]{12,}/, /AKIA[0-9A-Z]{12,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /(비밀번호|password|passwd|pwd|api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}/i, /gh[pousr]_[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{20,}/, /xox[abpr]-[A-Za-z0-9-]{10,}/, /["']?(api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{8,}/i, /authorization\s*[:=]\s*["']?(bearer|basic|token)\s+[A-Za-z0-9_\-.=+/]{12,}/i, /\bbearer\s+[A-Za-z0-9_\-.=+/]{20,}/i, /kch(ai|dc)_[A-Za-z0-9_-]{20,}/];
/** 소개서 fields the skill may write (same limits as the web form). */
const PROFILE_FIELDS = [
  { key: 'after', flag: 'sentence', label: '어떤 일을 편하게 하나요 (한 문장, 필수)', max: 2000 },
  { key: 'now', flag: 'before', label: '예전에는 어떻게 했나요', max: 500 },
  { key: 'progress_text', flag: 'progress', label: '지금 되는 부분이나 제한', max: 300 },
  { key: 'future_text', flag: 'next', label: '앞으로 할 일', max: 300 },
];

class UserError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const log = (message) => process.stderr.write(`${message}\n`);

/* ---------------- config ---------------- */

function configDir() {
  if (process.env.KCH_AI_HOME) return process.env.KCH_AI_HOME;
  if (IS_WINDOWS) return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'kch-ai');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kch-ai');
}
const CONFIG_FILE = () => join(configDir(), 'config.json');
const HISTORY_FILE = () => join(configDir(), 'last-change.json');

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writePrivate(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: the file lives in the user's own profile folder */
  }
}
const loadConfig = () => readJsonFile(CONFIG_FILE(), {});
const serverUrl = (options = {}) => (options.server || process.env.KCH_AI_SERVER || loadConfig().server || DEFAULT_SERVER).replace(/\/+$/, '');

/* ---------------- http ---------------- */

async function call(method, path, { body, token, server, raw, contentType } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': `kch-ai/${VERSION}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers['Content-Type'] = contentType || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let response;
  try {
    response = await fetch(`${server}/api/agent/v1${path}`, { method, headers, body: payload });
  } catch (error) {
    throw new UserError(`서버(${server})에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요. AI 도구의 샌드박스가 인터넷을 막고 있다면 샌드박스 밖 실행을 허용해 주세요. (${error?.cause?.code || error?.message || error})`);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok && !(path === '/login/poll' && data?.state)) {
    throw new UserError(data?.error || data?.message || `요청이 실패했습니다 (HTTP ${response.status}).`, response.status === 401 ? 3 : 1);
  }
  return data;
}

/** Calls with the saved connection; connects first (browser approval) when there is none or it ended. */
async function authed(method, path, options = {}) {
  let config = loadConfig();
  if (!config.token) config = await login();
  try {
    return await call(method, path, { ...options, token: config.token, server: serverUrl() });
  } catch (error) {
    if (!(error instanceof UserError) || error.code !== 3) throw error;
    log('연결이 끊겨 있어 다시 연결합니다.');
    config = await login();
    return call(method, path, { ...options, token: config.token, server: serverUrl() });
  }
}

/* ---------------- login (browser approval, once per computer) ---------------- */

function openBrowser(url) {
  try {
    if (IS_WINDOWS) spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
    else if (platform() === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'))) spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

async function login(options = {}) {
  const server = serverUrl(options);
  const clientName = `${hostname()} (${userInfo().username})`.slice(0, 120);
  const started = await call('POST', '/login/start', { body: { client_name: clientName }, server });
  log('');
  log('[kch-ai] 처음 한 번만 연결이 필요합니다. 브라우저에 열린 화면에서 [허용]을 눌러 주세요.');
  log(`  확인 코드: ${started.user_code}`);
  log(`  주소: ${started.verify_url}`);
  log('  (화면이 안 열리면 위 주소를 회사 계정으로 로그인된 크롬에 붙여 넣으세요)');
  if (!options.noBrowser && !process.env.KCH_AI_NO_BROWSER) openBrowser(started.verify_url);
  const deadline = Date.now() + started.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, (started.interval || 3) * 1000));
    const result = await call('POST', '/login/poll', { body: { device_code: started.device_code }, server });
    if (result.state === 'pending') continue;
    if (result.state === 'approved') {
      const config = { server, token: result.token, name: result.name, connection: result.connection, connected_at: new Date().toISOString() };
      writePrivate(CONFIG_FILE(), config);
      log(`[kch-ai] 연결됐습니다: ${result.name}. 다음부터는 묻지 않습니다.`);
      return config;
    }
    throw new UserError(result.message || '연결하지 못했습니다. 다시 실행해 주세요.');
  }
  throw new UserError('10분 안에 허용하지 않아 연결 요청이 끝났습니다. 다시 실행해 주세요.');
}

/* ---------------- helpers ---------------- */

function stageOf(input) {
  const key = String(input || '').toLowerCase().replace(/\s+/g, '');
  if (!key) return null;
  return STAGES.find((stage) => stage.value === input || stage.label.replace(/\s+/g, '').toLowerCase() === key || stage.words.includes(key)) || null;
}

function gitRoot(folder) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: folder || process.cwd(), stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
/** True when `file` (after following links) is inside `root` (after following links). */
function insideFolder(root, file) {
  let realRoot;
  let realFile;
  try {
    realRoot = realpathSync(root);
    realFile = realpathSync(file);
  } catch {
    return false;
  }
  const inside = relative(realRoot, realFile);
  return Boolean(inside) && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

function gitRepo(folder) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: folder || process.cwd(), stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    const match = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
    return match ? { owner: match[1].toLowerCase(), repo: match[2].toLowerCase(), url: `https://github.com/${match[1]}/${match[2]}` } : null;
  } catch {
    return null;
  }
}

async function ask(question) {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((done) => rl.question(question, done));
  rl.close();
  return String(answer).trim();
}

async function confirm(summary, options) {
  if (options.yes) return;
  if (!process.stdin.isTTY) throw new UserError(`확인이 필요합니다:\n${summary}\n사용자에게 보여 주고 확인받은 뒤 같은 명령에 --yes 를 붙여 다시 실행하세요.`, 2);
  const answer = (await ask(`${summary}\n진행할까요? (Y/n) `)).toLowerCase();
  if (answer && !['y', 'yes', '예', '네', 'ㅇ', 'ㅛ'].includes(answer)) throw new UserError('취소했습니다. 아무것도 바뀌지 않았습니다.', 0);
}

const me = () => authed('GET', '/me');

/** Finds the project: --project, then the folder's GitHub remote. */
async function findProject(options, profile) {
  const projects = profile.projects || [];
  if (options.project) {
    const wanted = String(options.project).trim().toLowerCase();
    const exact = projects.filter((project) => project.id === options.project || project.title.toLowerCase() === wanted);
    const found = exact.length ? exact : projects.filter((project) => project.title.toLowerCase().includes(wanted));
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new UserError(`"${options.project}"에 맞는 프로젝트가 여러 개입니다: ${found.map((project) => project.title).join(', ')}`);
    throw new UserError(`"${options.project}" 프로젝트가 없습니다. 내 프로젝트: ${projects.map((project) => project.title).join(', ') || '없음'}`);
  }
  const repo = gitRepo(options.folder);
  if (repo) {
    const linked = projects.filter((project) => project.repo && project.repo.owner.toLowerCase() === repo.owner && project.repo.repo.toLowerCase() === repo.repo);
    if (linked.length === 1) return linked[0];
  }
  return null;
}
async function requireProject(options, profile) {
  const project = await findProject(options, profile);
  if (project) return project;
  const projects = profile.projects || [];
  if (projects.length === 1 && !gitRepo(options.folder)) return projects[0];
  throw new UserError(`이 폴더와 연결된 프로젝트를 찾지 못했습니다. --project "이름"으로 지정하거나, 새 프로젝트면 new 명령으로 등록하세요. 내 프로젝트: ${projects.map((project) => project.title).join(', ') || '없음'}`);
}

function remember(change) {
  writePrivate(HISTORY_FILE(), { ...change, at: new Date().toISOString() });
}
function checkText(value, label, max) {
  const text = String(value ?? '').trim();
  if (text.length > max) throw new UserError(`${label}: ${max}자 이하로 줄여 주세요.`);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) throw new UserError(`${label}: 비밀번호나 키로 보이는 내용이 있어 올리지 않았습니다.`);
  return text;
}
const profileUpdates = (options) => PROFILE_FIELDS.filter((field) => options[field.flag] !== undefined).map((field) => ({ ...field, value: checkText(options[field.flag], field.label, field.max) }));

/* ---------------- operations ---------------- */

async function opList() {
  const profile = await me();
  const lines = [`${profile.name} (${profile.department})님의 프로젝트 ${profile.projects.length}개`];
  for (const project of profile.projects) lines.push(`- ${project.title}: ${project.stage_label}${project.repo ? ` · ${project.repo.owner}/${project.repo.repo}` : ''}\n  ${project.url}`);
  return lines.join('\n');
}

/** What the service holds now for this folder's project (or that there is none yet). */
async function opShow(options) {
  const profile = await me();
  const project = await findProject(options, profile);
  if (!project) {
    const repo = gitRepo(options.folder);
    return [
      '이 폴더와 연결된 프로젝트가 아직 없습니다.',
      repo ? `저장소: ${repo.url}` : '저장소: (GitHub 원격 없음)',
      `내 프로젝트: ${profile.projects.map((item) => item.title).join(', ') || '없음'}`,
      '새로 등록하려면: new "프로젝트 이름" --stage "개발 중" --sentence "한 문장" (선택: --before --progress --next)',
      '이미 있는 프로젝트라면: profile --project "이름" ... 으로 업데이트하면 이 저장소도 그 프로젝트에 연결됩니다.',
    ].join('\n');
  }
  const answers = (await authed('GET', `/projects/${encodeURIComponent(project.id)}/profile`)).profile.answers || {};
  return [
    `프로젝트: ${project.title}`,
    `진행 상태: ${project.stage_label}`,
    ...PROFILE_FIELDS.map((field) => `${field.label}: ${answers[field.key] || '(비어 있음)'}`),
    `저장소: ${project.repo ? `${project.repo.owner}/${project.repo.repo}` : '(연결 안 됨)'}`,
    project.url,
  ].join('\n');
}

/** This folder's repository for a project picked with --project: link only when it has none (never replace). */
function repoPlan(project, options) {
  const repo = options.project ? gitRepo(options.folder) : null;
  if (!repo) return { link: null, note: '' };
  if (!project.repo) return { link: repo, note: '' };
  if (project.repo.owner.toLowerCase() === repo.owner && project.repo.repo.toLowerCase() === repo.repo) return { link: null, note: '' };
  return { link: null, note: `\n참고: 이 프로젝트에는 이미 다른 저장소(${project.repo.owner}/${project.repo.repo})가 연결돼 있어 바꾸지 않았습니다. 바꾸려면 웹 프로젝트 화면에서 하세요.` };
}

async function opNew(options) {
  const title = checkText(options.title, '프로젝트 이름', 100);
  if (!title) throw new UserError('프로젝트 이름을 적어 주세요. 예: new "세금계산서 자동수집 로봇" --stage "개발 중" --sentence "..."');
  const stage = stageOf(options.stage || '개발 중');
  if (!stage) throw new UserError('진행 상태는 계획 중 / 개발 중 / QA 중 / 개발 완료 중 하나입니다.');
  const updates = profileUpdates(options);
  const sentence = updates.find((field) => field.key === 'after');
  if (!sentence?.value) throw new UserError('--sentence "어떤 일을 편하게 하나요 (한 문장)" 은 꼭 필요합니다.');
  const profile = await me();
  const same = profile.projects.find((project) => project.title.trim().toLowerCase() === title.toLowerCase());
  if (same) throw new UserError(`"${title}" 프로젝트가 이미 있습니다. 업데이트하려면 profile --project "${same.title}" 를 쓰세요.`);
  const repo = gitRepo(options.folder);
  await confirm([`새 프로젝트를 등록합니다.`, `  이름: ${title}`, `  진행 상태: ${stage.label}`, ...updates.map((field) => `  ${field.label}: ${field.value}`), repo ? `  저장소: ${repo.url}` : ''].filter(Boolean).join('\n'), options);
  const answers = {};
  for (const field of updates) answers[field.key] = field.value;
  if (answers.progress_text) answers.progress = 'partial';
  if (answers.future_text) answers.future = 'yes';
  const created = await authed('POST', '/projects', {
    body: { title, current_stage: stage.value, profile: answers, ...(repo ? { repo_url: repo.url } : {}), client_request_id: randomUUID() },
  });
  return `새 프로젝트를 등록했습니다: ${title} (${stage.label})\n${serverUrl()}/projects/${encodeURIComponent(created.project.id)}\n함께 하는 사람과 역할은 웹 프로젝트 화면에서 추가할 수 있습니다.`;
}

async function opProfile(options) {
  const updates = profileUpdates(options);
  const stage = options.stage ? stageOf(options.stage) : null;
  if (options.stage && !stage) throw new UserError('진행 상태는 계획 중 / 개발 중 / QA 중 / 개발 완료 중 하나입니다.');
  if (!updates.length && !stage) throw new UserError('바꿀 내용을 적어 주세요: --sentence, --before, --progress, --next, --stage');
  const profile = await me();
  const project = await requireProject(options, profile);
  const current = (await authed('GET', `/projects/${encodeURIComponent(project.id)}/profile`)).profile;
  const answers = { ...current.answers };
  const changed = updates.filter((field) => String(answers[field.key] || '').trim() !== field.value);
  const stageChanged = Boolean(stage) && project.stage !== stage.value;
  const plan = repoPlan(project, options);
  if (!changed.length && !stageChanged && !plan.link) return `${project.title}: 이미 같은 내용입니다. 바꿀 것이 없습니다.${plan.note}`;
  if (changed.some((field) => field.key === 'after' && !field.value)) throw new UserError('한 문장은 비울 수 없습니다.');
  await confirm([
    `${project.title}: 아래처럼 바꿉니다.`,
    stageChanged ? `  진행 상태: ${project.stage_label} → ${stage.label}` : '',
    ...changed.map((field) => `  ${field.label}\n    지금: ${answers[field.key] || '(비어 있음)'}\n    새로: ${field.value || '(비움)'}`),
    plan.link ? `  저장소 연결: ${plan.link.url} (이 폴더)` : '',
  ].filter(Boolean).join('\n'), options);
  if (changed.length) {
    for (const field of changed) answers[field.key] = field.value;
    if (answers.progress_text && !answers.progress) answers.progress = 'partial';
    if (answers.future_text && !answers.future) answers.future = 'yes';
    await authed('PUT', `/projects/${encodeURIComponent(project.id)}/profile`, { body: { answers, expected_version: current.version } });
  }
  if (stageChanged) {
    const latest = await authed('GET', `/projects/${encodeURIComponent(project.id)}`);
    await authed('PATCH', `/projects/${encodeURIComponent(project.id)}`, { body: { current_stage: stage.value, expected_version: latest.project.version } });
  }
  if (changed.length || stageChanged) {
    remember({
      kind: 'profile2', project_id: project.id, title: project.title,
      fields: changed.map((field) => ({ key: field.key, label: field.label, before: String(current.answers[field.key] || ''), after: field.value })),
      stage: stageChanged ? { before: project.stage, after: stage.value } : null,
    });
  }
  if (plan.link) await authed('PUT', `/projects/${encodeURIComponent(project.id)}/repo`, { body: { url: plan.link.url } });
  const what = [stageChanged ? '진행 상태' : '', changed.length ? `소개서 ${changed.length}개 항목` : '', plan.link ? '저장소 연결' : ''].filter(Boolean).join(', ');
  return `${project.title}: ${what}을(를) 반영했습니다.${plan.note}\n${project.url}`;
}

async function opAttach(options) {
  const files = (options.files || []).map((file) => resolve(options.folder || process.cwd(), file));
  if (!files.length) throw new UserError('올릴 파일을 적어 주세요. 예: attach ./screenshot.png ./README.md');
  for (const file of files) {
    if (!existsSync(file)) throw new UserError(`파일을 찾을 수 없습니다: ${file}`);
    const ext = extname(file).toLowerCase();
    if (!MIME_BY_EXT[ext]) throw new UserError(`${basename(file)}: PDF, PNG, JPG, GIF, MD, TXT, LOG 파일만 올릴 수 있습니다.`);
    const size = statSync(file).size;
    if (size <= 0 || size > MAX_FILE_BYTES) throw new UserError(`${basename(file)}: 20MB 이하만 올릴 수 있습니다.`);
    if (MIME_BY_EXT[ext] === 'text/markdown' && SECRET_PATTERNS.some((pattern) => pattern.test(readFileSync(file, 'utf8')))) {
      throw new UserError(`${basename(file)}: 비밀번호나 키로 보이는 내용이 있어 올리지 않았습니다.`);
    }
  }
  const profile = await me();
  const project = await requireProject(options, profile);
  await confirm(`${project.title}: 첨부 ${files.length}개를 올립니다.\n${files.map((file) => `  ${file}`).join('\n')}\n첨부는 전 직원이 볼 수 있습니다.`, options);
  for (const file of files) {
    const bytes = readFileSync(file);
    const name = basename(file);
    const mime = MIME_BY_EXT[extname(file).toLowerCase()];
    const asset = await authed('POST', `/projects/${encodeURIComponent(project.id)}/assets`, { body: { name, room: 'design', client_request_id: randomUUID() } });
    const reserved = await authed('POST', `/assets/${encodeURIComponent(asset.asset.id)}/files/reservations`, {
      body: { client_request_id: randomUUID(), name, mime_type: mime, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') },
    });
    const uploadPath = String(reserved.upload_url || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
    if (!uploadPath.startsWith('/files/')) throw new UserError('파일 올리기 주소를 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
    await authed('PUT', uploadPath, { raw: bytes, contentType: mime });
  }
  return `${project.title}: 첨부 ${files.length}개를 올렸습니다.\n${project.url}`;
}

/** Undo only what this computer changed, and only while nobody has changed those values since. */
async function opUndo(options) {
  const last = readJsonFile(HISTORY_FILE(), null);
  if (!last || last.kind !== 'profile2') throw new UserError('되돌릴 변경이 없습니다. (이 컴퓨터에서 마지막으로 바꾼 1건만 되돌릴 수 있습니다)');
  if (Date.now() - Date.parse(last.at) > 24 * 60 * 60 * 1000) throw new UserError('24시간이 지난 변경은 웹에서 고쳐 주세요.');
  const current = (await authed('GET', `/projects/${encodeURIComponent(last.project_id)}/profile`)).profile;
  const latest = await authed('GET', `/projects/${encodeURIComponent(last.project_id)}`);
  const moved = last.fields.filter((field) => String(current.answers[field.key] || '').trim() !== field.after);
  if (moved.length || (last.stage && latest.project.current_stage !== last.stage.after)) {
    throw new UserError(`${last.title}: 그 뒤에 다른 사람이 ${[...moved.map((field) => field.label), last.stage && latest.project.current_stage !== last.stage.after ? '진행 상태' : ''].filter(Boolean).join(', ')}을(를) 바꿔서 되돌리지 않았습니다. 웹에서 확인해 주세요.`);
  }
  await confirm(`${last.title}: 마지막 변경(${[...last.fields.map((field) => field.label), last.stage ? '진행 상태' : ''].filter(Boolean).join(', ')})을 되돌립니다.`, options);
  if (last.fields.length) {
    const answers = { ...current.answers };
    for (const field of last.fields) answers[field.key] = field.before;
    await authed('PUT', `/projects/${encodeURIComponent(last.project_id)}/profile`, { body: { answers, expected_version: current.version } });
  }
  if (last.stage) {
    await authed('PATCH', `/projects/${encodeURIComponent(last.project_id)}`, { body: { current_stage: last.stage.before, expected_version: latest.project.version } });
  }
  rmSync(HISTORY_FILE(), { force: true });
  return `${last.title}: 마지막 변경을 되돌렸습니다.`;
}

/* ---------------- project sheet (kch-ai-project.md): write it, review it, apply it ---------------- */

const SHEET_NAME = 'kch-ai-project.md';
const ROLES = [
  { value: 'planning', label: '기획', words: ['기획', 'planning', 'pm'] },
  { value: 'development', label: '개발', words: ['개발', 'development', 'dev', '개발자'] },
  { value: 'qa', label: 'QA', words: ['qa', '테스트', '검증'] },
  { value: 'business', label: '현업 담당', words: ['현업담당', '현업', 'business', '업무담당'] },
  { value: 'operations', label: '운영', words: ['운영', 'operations', 'ops'] },
];
const roleLabel = (value) => ROLES.find((role) => role.value === value)?.label || value;
function parseRoles(text, where) {
  const parts = String(text || '').split(/[,·/、]|\s및\s/).map((part) => part.trim()).filter(Boolean);
  const roles = [];
  for (const part of parts) {
    const key = part.toLowerCase().replace(/\s+/g, '');
    const role = ROLES.find((item) => item.words.includes(key) || item.label.replace(/\s+/g, '').toLowerCase() === key);
    if (!role) throw new UserError(`${where}: "${part}"는 역할이 아닙니다. 기획 / 개발 / QA / 현업 담당 / 운영 중에서 적어 주세요.`);
    if (!roles.includes(role.value)) roles.push(role.value);
  }
  return roles;
}

const SHEET_SECTIONS = [
  { key: 'after', match: /한\s*문장|어떤 일/, title: '어떤 일을 편하게 하나요 (한 문장, 필수)' },
  { key: 'now', match: /예전/, title: '예전에는 어떻게 했나요' },
  { key: 'progress_text', match: /지금|제한/, title: '지금 되는 부분이나 제한' },
  { key: 'future_text', match: /앞으로/, title: '앞으로 할 일' },
  { key: 'people', match: /함께|담당자|참여자/, title: '함께 하는 사람' },
  { key: 'files', match: /첨부/, title: '첨부' },
  { key: 'notes', match: /참고|메모|상세/, title: '참고 (현황관리 입력칸에는 들어가지 않고, 이 문서 첨부로만 공유)' },
];

function renderSheet(data) {
  const lines = [
    `# ${data.title || '프로젝트 이름'}`,
    '',
    `- 진행 상태: ${data.stage_label || '개발 중'}`,
    `- 내 역할: ${(data.my_roles || []).map(roleLabel).join(', ')}`,
    '',
  ];
  for (const section of SHEET_SECTIONS) {
    lines.push(`## ${section.title}`, '');
    if (section.key === 'people') for (const person of data.people || []) lines.push(`- ${person.name} (${person.department}): ${person.roles.map(roleLabel).join(', ')}`);
    else if (section.key === 'files') for (const file of data.files || []) lines.push(`- ${file}`);
    else if (data[section.key]) lines.push(data[section.key]);
    lines.push('');
  }
  lines.push('<!-- kch-ai 스킬이 이 문서를 기준으로 KCH AI 현황관리에 반영합니다. 진행 상태: 계획 중 / 개발 중 / QA 중 / 개발 완료. 역할: 기획 / 개발 / QA / 현업 담당 / 운영. 첨부 경로는 이 문서 기준. 비밀번호·키·개인정보 금지. -->');
  return `${lines.join('\n')}\n`;
}

function parseSheet(text) {
  const sheet = { title: '', stage: null, my_roles: null, fields: {}, people: [], files: [], notes: '' };
  let section = null;
  const buffer = {};
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#\s+/.test(line) && !sheet.title) { sheet.title = line.replace(/^#\s+/, '').trim(); section = null; continue; }
    if (/^##\s+/.test(line)) {
      const heading = line.replace(/^##\s+/, '');
      section = SHEET_SECTIONS.find((item) => item.match.test(heading))?.key || 'ignored';
      buffer[section] = buffer[section] || [];
      continue;
    }
    if (!section) {
      const meta = /^[-*]\s*(진행\s*상태|내\s*역할)\s*[:：]\s*(.*)$/.exec(line.trim());
      if (meta && /진행/.test(meta[1])) sheet.stage = meta[2].trim();
      if (meta && /역할/.test(meta[1])) sheet.my_roles = meta[2].trim();
      continue;
    }
    buffer[section].push(line);
  }
  const textOf = (key) => (buffer[key] || []).join('\n').trim().replace(/^\(?(없음|비어 있음)\)?$/, '');
  for (const key of ['after', 'now', 'progress_text', 'future_text']) if (buffer[key]) sheet.fields[key] = textOf(key);
  sheet.notes = textOf('notes');
  for (const line of buffer.people || []) {
    const match = /^[-*]\s*([^(:：]+?)\s*(?:\(([^)]*)\))?\s*(?:[:：]\s*(.*))?$/.exec(line.trim());
    if (match && match[1].trim()) sheet.people.push({ name: match[1].trim(), department: (match[2] || '').trim(), roles: (match[3] || '').trim() });
  }
  for (const line of buffer.files || []) {
    const match = /^[-*]\s*(.+)$/.exec(line.trim());
    if (match) sheet.files.push(match[1].replace(/^`|`$/g, '').trim());
  }
  return sheet;
}

async function staffOf(projectId) {
  const rows = (await authed('GET', `/projects/${encodeURIComponent(projectId)}/staff`)).staff || [];
  return rows.filter((row) => row.active !== false);
}

/** Every attachment of the project: { attachmentId, version, name, sha256 }. */
async function attachmentsOf(projectId) {
  const assets = (await authed('GET', `/projects/${encodeURIComponent(projectId)}/assets`)).assets || [];
  const out = [];
  for (const asset of assets) {
    if (asset.deleted_at) continue;
    const files = (await authed('GET', `/assets/${encodeURIComponent(asset.id)}/files`)).attachments || [];
    for (const file of files) {
      if (!file.active || file.deleted_at || !file.current) continue;
      out.push({ assetId: asset.id, attachmentId: file.id, version: file.version, name: file.current.name, sha256: String(file.current.sha256 || '').toLowerCase() });
    }
  }
  return out;
}

async function uploadFile(project, file, existing) {
  const bytes = readFileSync(file);
  const name = basename(file);
  const mime = MIME_BY_EXT[extname(file).toLowerCase()];
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let assetId = existing?.assetId;
  if (!assetId) assetId = (await authed('POST', `/projects/${encodeURIComponent(project.id)}/assets`, { body: { name, room: 'design', client_request_id: randomUUID() } })).asset.id;
  const reserved = await authed('POST', `/assets/${encodeURIComponent(assetId)}/files/reservations`, {
    body: { client_request_id: randomUUID(), name, mime_type: mime, size: bytes.byteLength, sha256, ...(existing ? { attachment_id: existing.attachmentId, expected_version: existing.version } : {}) },
  });
  const uploadPath = String(reserved.upload_url || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
  if (!uploadPath.startsWith('/files/')) throw new UserError('파일 올리기 주소를 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
  await authed('PUT', uploadPath, { raw: bytes, contentType: mime });
}

function checkFile(file) {
  if (!existsSync(file)) throw new UserError(`첨부 파일을 찾을 수 없습니다: ${file}`);
  const ext = extname(file).toLowerCase();
  if (!MIME_BY_EXT[ext]) throw new UserError(`${basename(file)}: PDF, PNG, JPG, GIF, MD, TXT, LOG 파일만 올릴 수 있습니다.`);
  const size = statSync(file).size;
  if (size <= 0 || size > MAX_FILE_BYTES) throw new UserError(`${basename(file)}: 20MB 이하만 올릴 수 있습니다.`);
  if (MIME_BY_EXT[ext] === 'text/markdown' && SECRET_PATTERNS.some((pattern) => pattern.test(readFileSync(file, 'utf8')))) {
    throw new UserError(`${basename(file)}: 비밀번호나 키로 보이는 내용이 있어 올리지 않았습니다.`);
  }
}

/** Finds people by name (and department or e-mail when given). One match each, or a clear question. */
async function resolvePeople(entries, meId) {
  const resolved = [];
  for (const entry of entries) {
    const query = entry.name.includes('@') ? entry.name : entry.name;
    const found = (await authed('GET', `/staff/search?q=${encodeURIComponent(query)}`)).staff || [];
    let candidates = found.filter((person) => person.name === entry.name || person.company_email === entry.name.toLowerCase());
    if (entry.department) candidates = candidates.filter((person) => String(person.department).includes(entry.department) || entry.department.includes(String(person.department)));
    if (!candidates.length) throw new UserError(`함께 하는 사람 "${entry.name}"${entry.department ? ` (${entry.department})` : ''}을(를) 사내 명부에서 찾지 못했습니다. 이름을 확인하거나 회사 이메일로 적어 주세요.`);
    if (candidates.length > 1) throw new UserError(`"${entry.name}"이(가) ${candidates.length}명입니다: ${candidates.map((person) => `${person.name} (${person.department}, ${person.company_email})`).join(' / ')}. 본부나 이메일을 적어 구분해 주세요.`);
    resolved.push({ id: candidates[0].id, name: candidates[0].name, department: candidates[0].department, roles: parseRoles(entry.roles, `함께 하는 사람 ${entry.name}`), me: candidates[0].id === meId });
  }
  return resolved;
}

/** The project as a sheet: what is stored now (or an empty template when there is no project yet). */
async function opSheet(options) {
  const profile = await me();
  const project = await findProject(options, profile);
  if (!project) return renderSheet({ title: '', stage_label: '개발 중', my_roles: [], people: [], files: [] });
  const answers = (await authed('GET', `/projects/${encodeURIComponent(project.id)}/profile`)).profile.answers || {};
  const staff = await staffOf(project.id);
  const mine = staff.find((row) => row.name === profile.name && row.department === profile.department);
  const files = (await attachmentsOf(project.id)).map((file) => file.name).filter((name) => name !== SHEET_NAME);
  return renderSheet({
    title: project.title,
    stage_label: project.stage_label,
    my_roles: mine?.roles || [],
    after: answers.after, now: answers.now, progress_text: answers.progress_text, future_text: answers.future_text,
    people: staff.filter((row) => row !== mine).map((row) => ({ name: row.name, department: row.department, roles: row.roles || [] })),
    files: files.length ? files.map((name) => `${name}  (이미 올라가 있음)`) : [],
  });
}

/** Applies kch-ai-project.md: project, 소개서, my roles, people, attachments, and the sheet itself. */
async function opApply(options) {
  const sheetPath = resolve(options.folder || process.cwd(), options.file || SHEET_NAME);
  if (!existsSync(sheetPath)) throw new UserError(`${sheetPath} 가 없습니다. 먼저 sheet 명령으로 틀을 받아 ${SHEET_NAME} 를 만들어 주세요.`);
  const sheetText = readFileSync(sheetPath, 'utf8');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(sheetText))) throw new UserError(`${basename(sheetPath)}: 비밀번호나 키로 보이는 내용이 있어 반영하지 않았습니다.`);
  const sheet = parseSheet(sheetText);
  const baseDir = dirname(sheetPath);
  const folderOptions = { ...options, folder: baseDir };
  const title = checkText(sheet.title, '프로젝트 이름', 100);
  if (!title || title === '프로젝트 이름') throw new UserError('문서 맨 위 "# 프로젝트 이름"을 채워 주세요.');
  const stage = stageOf(sheet.stage || '개발 중');
  if (!stage) throw new UserError(`진행 상태 "${sheet.stage}"를 알 수 없습니다. 계획 중 / 개발 중 / QA 중 / 개발 완료 중 하나로 적어 주세요.`);
  const fields = PROFILE_FIELDS.filter((field) => sheet.fields[field.key] !== undefined).map((field) => ({ ...field, value: checkText(sheet.fields[field.key], field.label, field.max) }));
  if (!fields.find((field) => field.key === 'after')?.value) throw new UserError('"어떤 일을 편하게 하나요 (한 문장)" 칸은 꼭 채워 주세요.');
  const myRoles = sheet.my_roles === null ? null : parseRoles(sheet.my_roles, '내 역할');
  const files = sheet.files.map((file) => file.replace(/\s+\(이미 올라가 있음\)$/, '')).filter(Boolean);
  const profile = await me();
  const meRow = (await authed('GET', `/staff/search?q=${encodeURIComponent(profile.name)}`)).staff?.find((person) => person.name === profile.name && person.department === profile.department);
  const people = (await resolvePeople(sheet.people, meRow?.id)).filter((person) => !person.me);

  // Which project: --project, this folder's repository, or the same title among my projects.
  let project = await findProject(folderOptions, profile);
  if (!project) project = profile.projects.find((item) => item.title.trim().toLowerCase() === title.toLowerCase()) || null;
  const repo = gitRepo(baseDir);

  const plan = [];
  let current = null;
  let staff = [];
  let existingFiles = [];
  if (!project) {
    plan.push(`새 프로젝트 등록: ${title} (${stage.label})`);
    for (const field of fields) if (field.value) plan.push(`  ${field.label}: ${field.value}`);
    if (myRoles) plan.push(`  내 역할: ${myRoles.map(roleLabel).join(', ') || '(없음)'}`);
    if (repo) plan.push(`  저장소 연결: ${repo.url}`);
  } else {
    current = (await authed('GET', `/projects/${encodeURIComponent(project.id)}/profile`)).profile;
    staff = await staffOf(project.id);
    existingFiles = await attachmentsOf(project.id);
    if (project.title !== title) plan.push(`참고: 이름은 "${project.title}" 그대로 둡니다 (이름 변경은 웹에서).`);
    if (project.stage !== stage.value) plan.push(`진행 상태: ${project.stage_label} → ${stage.label}`);
    for (const field of fields) if (String(current.answers[field.key] || '').trim() !== field.value) plan.push(`${field.label}\n    지금: ${current.answers[field.key] || '(비어 있음)'}\n    새로: ${field.value || '(비움)'}`);
    const mine = staff.find((row) => row.employee_id === meRow?.id);
    if (myRoles && mine && JSON.stringify([...(mine.roles || [])].sort()) !== JSON.stringify([...myRoles].sort())) plan.push(`내 역할: ${(mine.roles || []).map(roleLabel).join(', ') || '(없음)'} → ${myRoles.map(roleLabel).join(', ') || '(없음)'}`);
    if (repo && !project.repo) plan.push(`저장소 연결: ${repo.url}`);
  }
  for (const person of people) {
    const row = staff.find((item) => item.employee_id === person.id);
    if (!row) plan.push(`함께 하는 사람 추가: ${person.name} (${person.department}) · ${person.roles.map(roleLabel).join(', ') || '역할 없음'}`);
    else if (JSON.stringify([...(row.roles || [])].sort()) !== JSON.stringify([...person.roles].sort())) plan.push(`역할 변경: ${person.name} ${(row.roles || []).map(roleLabel).join(', ') || '(없음)'} → ${person.roles.map(roleLabel).join(', ') || '(없음)'}`);
  }
  const notListed = staff.filter((row) => row.employee_id !== meRow?.id && !people.some((person) => person.id === row.employee_id));
  const uploads = [];
  const kept = [];
  // Files must be inside this project's git repository (or the sheet's folder when there is none),
  // checked on real paths so links cannot point outside (QA 2026-10-09, Kimi + Opus).
  const root = gitRoot(baseDir);
  const allowedRoot = root || baseDir;
  if (!root) plan.push(`참고: 이 문서는 git 저장소 밖에 있습니다. 첨부는 ${baseDir} 안의 파일만 올립니다.`);
  if (!insideFolder(allowedRoot, sheetPath)) throw new UserError(`${basename(sheetPath)}: 문서 위치를 확인할 수 없습니다.`);
  for (const listed of files) {
    const file = resolve(baseDir, listed);
    const inside = relative(baseDir, file);
    // Already on the service and not here: keep it as it is.
    if (!existsSync(file) && existingFiles.some((item) => item.name === basename(file)) && !inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)) { kept.push(basename(file)); continue; }
    checkFile(file);
    if (!insideFolder(allowedRoot, file)) throw new UserError(`첨부 "${listed}": ${root ? '이 프로젝트 저장소' : '이 문서가 있는 폴더'} 안의 파일만 올릴 수 있습니다 (바로가기·링크로 밖을 가리키는 파일 포함). 다른 곳의 파일은 attach 명령으로 따로 올려 주세요.`);
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (existingFiles.find((item) => item.sha256 === sha)) continue;
    const named = existingFiles.find((item) => item.name === basename(file));
    uploads.push({ file, existing: named || null });
    plan.push(`${named ? '첨부 새 버전' : '첨부 추가'}: ${inside.split('\\').join('/')}`);
  }
  {
    checkFile(sheetPath);
    const sha = createHash('sha256').update(readFileSync(sheetPath)).digest('hex');
    if (!existingFiles.find((item) => item.sha256 === sha)) {
      const named = existingFiles.find((item) => item.name === basename(sheetPath));
      uploads.push({ file: sheetPath, existing: named || null });
      plan.push(`${named ? '첨부 새 버전' : '첨부 추가'}: ${basename(sheetPath)} (이 정리 문서)`);
    }
  }
  if (kept.length) plan.push(`참고: ${kept.join(', ')} 은(는) 이미 올라가 있어 그대로 둡니다.`);
  if (!plan.filter((line) => !line.startsWith('참고')).length) {
    return `${title}: 문서와 현황관리 내용이 이미 같습니다. 바꿀 것이 없습니다.${notListed.length ? `\n참고: 문서에 없는 참여자(${notListed.map((row) => row.name).join(', ')})는 그대로 둡니다. 빼려면 웹에서 하세요.` : ''}`;
  }
  if (notListed.length) plan.push(`참고: 문서에 없는 참여자(${notListed.map((row) => row.name).join(', ')})는 그대로 둡니다 (빼기는 웹에서).`);
  await confirm(`${basename(sheetPath)} 기준으로 현황관리에 반영합니다.\n- ${plan.join('\n- ')}\n첨부는 전 직원이 볼 수 있습니다.`, options);

  // Apply.
  if (!project) {
    const answers = {};
    for (const field of fields) answers[field.key] = field.value;
    if (answers.progress_text) answers.progress = 'partial';
    if (answers.future_text) answers.future = 'yes';
    const created = await authed('POST', '/projects', {
      body: { title, current_stage: stage.value, profile: answers, ...(myRoles?.length ? { creator_roles: myRoles } : {}), ...(repo ? { repo_url: repo.url } : {}), client_request_id: randomUUID() },
    });
    project = { id: created.project.id, title, url: `${serverUrl()}/projects/${encodeURIComponent(created.project.id)}`, repo: repo ? { owner: repo.owner, repo: repo.repo } : null };
    staff = await staffOf(project.id);
  } else {
    const changed = fields.filter((field) => String(current.answers[field.key] || '').trim() !== field.value);
    if (changed.length) {
      const answers = { ...current.answers };
      for (const field of changed) answers[field.key] = field.value;
      if (answers.progress_text && !answers.progress) answers.progress = 'partial';
      if (answers.future_text && !answers.future) answers.future = 'yes';
      await authed('PUT', `/projects/${encodeURIComponent(project.id)}/profile`, { body: { answers, expected_version: current.version } });
    }
    if (project.stage !== stage.value) {
      const latest = await authed('GET', `/projects/${encodeURIComponent(project.id)}`);
      await authed('PATCH', `/projects/${encodeURIComponent(project.id)}`, { body: { current_stage: stage.value, expected_version: latest.project.version } });
    }
    if (changed.length || project.stage !== stage.value) {
      remember({ kind: 'profile2', project_id: project.id, title: project.title, fields: changed.map((field) => ({ key: field.key, label: field.label, before: String(current.answers[field.key] || ''), after: field.value })), stage: project.stage !== stage.value ? { before: project.stage, after: stage.value } : null });
    }
    if (repo && !project.repo) await authed('PUT', `/projects/${encodeURIComponent(project.id)}/repo`, { body: { url: repo.url } });
    const mine = staff.find((row) => row.employee_id === meRow?.id);
    if (myRoles && mine && JSON.stringify([...(mine.roles || [])].sort()) !== JSON.stringify([...myRoles].sort())) {
      await authed('PATCH', `/projects/${encodeURIComponent(project.id)}/staff/${encodeURIComponent(mine.employee_id)}`, { body: { roles: myRoles, expected_version: mine.version } });
    }
  }
  for (const person of people) {
    const row = staff.find((item) => item.employee_id === person.id);
    if (!row) await authed('POST', `/projects/${encodeURIComponent(project.id)}/staff`, { body: { employee_id: person.id, roles: person.roles, client_request_id: randomUUID() } });
    else if (JSON.stringify([...(row.roles || [])].sort()) !== JSON.stringify([...person.roles].sort())) {
      await authed('PATCH', `/projects/${encodeURIComponent(project.id)}/staff/${encodeURIComponent(person.id)}`, { body: { roles: person.roles, expected_version: row.version } });
    }
  }
  for (const upload of uploads) await uploadFile(project, upload.file, upload.existing);
  return `${title}: ${basename(sheetPath)} 기준으로 반영했습니다 (${plan.filter((line) => !line.startsWith('참고') && !line.startsWith('  ')).length}건).\n${project.url || `${serverUrl()}/projects/${encodeURIComponent(project.id)}`}`;
}

/* ---------------- CLI ---------------- */

const HELP = `kch-ai ${VERSION} · KCH AI 현황관리 (문의: ${CONTACT})

  sheet                                 정리 문서(kch-ai-project.md) 틀 또는 지금 내용을 문서 형식으로
  apply [kch-ai-project.md]             정리 문서 기준으로 등록·업데이트 (소개서·역할·함께 하는 사람·첨부)
  show                                  이 폴더 프로젝트의 지금 내용 (없으면 '아직 없음')
  list                                  내 프로젝트 목록
  new "이름" --stage "개발 중" --sentence "한 문장" [--before ..] [--progress ..] [--next ..]
                                        새 프로젝트 등록 (이 폴더의 GitHub 저장소도 연결)
  profile [--sentence ..] [--before ..] [--progress ..] [--next ..] [--stage ..]
                                        소개서·진행 상태 업데이트
  attach 파일...                        첨부 (PDF PNG JPG GIF MD TXT LOG, 20MB 이하)
  undo                                  마지막 변경 되돌리기 (24시간 안)
  login | logout | whoami | version

  --project "이름"   프로젝트 지정 (지정하면 이 폴더 저장소도 그 프로젝트에 연결)
  --yes              확인 없이 실행 (AI가 사용자 확인을 받은 뒤 사용)
진행 상태: 계획 중 / 개발 중 / QA 중 / 개발 완료`;

const VALUE_FLAGS = new Set(['project', 'stage', 'sentence', 'before', 'progress', 'next', 'server', 'folder', 'file']);
function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const eq = arg.indexOf('=');
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-browser') options.noBrowser = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--') && eq > 2 && VALUE_FLAGS.has(arg.slice(2, eq))) options[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (arg.startsWith('--') && VALUE_FLAGS.has(arg.slice(2))) options[arg.slice(2)] = argv[++index] ?? '';
    else options._.push(arg);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const aliases = { 정리: 'sheet', 반영: 'apply', sentence: 'profile', status: 'profile', setup: 'login', ls: 'list', 등록: 'new', 업데이트: 'profile', 보기: 'show', 첨부: 'attach', 되돌리기: 'undo' };
  const raw = options._[0] || 'help';
  const command = aliases[raw] || raw;
  const rest = options._.slice(1);
  if (options.help || command === 'help') return console.log(HELP);
  // Short forms: `status`, `status "QA 중"`, `sentence "문장"`.
  if (raw === 'status') {
    if (!rest.length) return console.log(await opShow(options));
    options.stage = rest.join(' ');
  }
  if (raw === 'sentence' && rest.length) options.sentence = rest.join(' ');
  switch (command) {
    case 'version':
      return console.log(VERSION);
    case 'login':
      await login(options);
      return console.log('연결됐습니다.');
    case 'logout':
      try {
        await call('POST', '/logout', { token: loadConfig().token, server: serverUrl() });
      } catch {
        /* already disconnected */
      }
      rmSync(CONFIG_FILE(), { force: true });
      return console.log('이 컴퓨터의 연결을 끊었습니다.');
    case 'whoami': {
      const profile = await me();
      return console.log(`${profile.name} (${profile.department}) · ${loadConfig().connection || ''}`);
    }
    case 'list':
      return console.log(await opList());
    case 'show':
      return console.log(await opShow(options));
    case 'sheet':
      return process.stdout.write(await opSheet(options));
    case 'apply':
      return console.log(await opApply({ ...options, file: rest[0] || options.file }));
    case 'new':
      return console.log(await opNew({ ...options, title: rest.join(' ') }));
    case 'profile':
      return console.log(await opProfile(options));
    case 'attach':
      return console.log(await opAttach({ ...options, files: rest }));
    case 'undo':
      return console.log(await opUndo(options));
    default:
      throw new UserError(`알 수 없는 명령입니다: ${raw}\n\n${HELP}`);
  }
}

main().catch((error) => {
  if (error instanceof UserError) {
    console.error(error.message);
    if (error.code === 1) console.error(`(해결이 안 되면 ${CONTACT} 로 문의해 주세요)`);
    process.exit(error.code);
  }
  console.error(`예상하지 못한 오류입니다: ${error?.stack || error}\n(${CONTACT} 로 문의해 주세요)`);
  process.exit(1);
});
