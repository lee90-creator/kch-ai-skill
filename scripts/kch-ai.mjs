#!/usr/bin/env node
/**
 * kch-ai: KCH AI 현황관리 스킬의 실행 도구 (의존성 없음, Node.js 18 이상).
 * AI(Codex, Claude Code 등)가 이 파일을 실행해 내 프로젝트를 등록·업데이트합니다.
 * 처음 실행하면 브라우저에 [허용] 화면이 한 번 열립니다. 문의: lee90@kchglobal.co.kr
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '1.1.0';
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
const SECRET_PATTERNS = [/sk-[A-Za-z0-9_-]{12,}/, /AKIA[0-9A-Z]{12,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /(비밀번호|password|passwd|pwd|api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}/i, /gh[pousr]_[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{20,}/, /xox[abpr]-[A-Za-z0-9-]{10,}/];
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

async function linkRepo(project, options) {
  const repo = gitRepo(options.folder);
  if (!repo || (project.repo && project.repo.owner.toLowerCase() === repo.owner && project.repo.repo.toLowerCase() === repo.repo)) return '';
  await authed('PUT', `/projects/${encodeURIComponent(project.id)}/repo`, { body: { url: repo.url } });
  return `\n이 폴더의 저장소(${repo.owner}/${repo.repo})를 연결했습니다. 다음부터는 이 폴더에서 자동으로 찾습니다.`;
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
  if (!changed.length && !stageChanged) return `${project.title}: 이미 같은 내용입니다. 바꿀 것이 없습니다.`;
  if (changed.some((field) => field.key === 'after' && !field.value)) throw new UserError('한 문장은 비울 수 없습니다.');
  await confirm([
    `${project.title}: 아래처럼 바꿉니다.`,
    stageChanged ? `  진행 상태: ${project.stage_label} → ${stage.label}` : '',
    ...changed.map((field) => `  ${field.label}\n    지금: ${answers[field.key] || '(비어 있음)'}\n    새로: ${field.value || '(비움)'}`),
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
  remember({ kind: 'profile', project_id: project.id, title: project.title, before_answers: current.answers, before_stage: stageChanged ? project.stage : null });
  const linked = options.project ? await linkRepo(project, options) : '';
  const what = [stageChanged ? '진행 상태' : '', changed.length ? `소개서 ${changed.length}개 항목` : ''].filter(Boolean).join(', ');
  return `${project.title}: ${what}을(를) 바꿨습니다.${linked}\n${project.url}`;
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
  await confirm(`${project.title}: 첨부 ${files.length}개를 올립니다 (${files.map((file) => basename(file)).join(', ')}). 첨부는 전 직원이 볼 수 있습니다.`, options);
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

async function opUndo(options) {
  const last = readJsonFile(HISTORY_FILE(), null);
  if (!last || last.kind !== 'profile') throw new UserError('되돌릴 변경이 없습니다. (이 컴퓨터에서 마지막으로 바꾼 1건만 되돌릴 수 있습니다)');
  if (Date.now() - Date.parse(last.at) > 24 * 60 * 60 * 1000) throw new UserError('24시간이 지난 변경은 웹에서 고쳐 주세요.');
  await confirm(`${last.title}: 마지막 변경을 되돌립니다.`, options);
  const current = (await authed('GET', `/projects/${encodeURIComponent(last.project_id)}/profile`)).profile;
  await authed('PUT', `/projects/${encodeURIComponent(last.project_id)}/profile`, { body: { answers: last.before_answers, expected_version: current.version } });
  if (last.before_stage) {
    const latest = await authed('GET', `/projects/${encodeURIComponent(last.project_id)}`);
    await authed('PATCH', `/projects/${encodeURIComponent(last.project_id)}`, { body: { current_stage: last.before_stage, expected_version: latest.project.version } });
  }
  rmSync(HISTORY_FILE(), { force: true });
  return `${last.title}: 마지막 변경을 되돌렸습니다.`;
}

/* ---------------- CLI ---------------- */

const HELP = `kch-ai ${VERSION} · KCH AI 현황관리 (문의: ${CONTACT})

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

const VALUE_FLAGS = new Set(['project', 'stage', 'sentence', 'before', 'progress', 'next', 'server', 'folder']);
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
  const aliases = { sentence: 'profile', status: 'profile', setup: 'login', ls: 'list', 등록: 'new', 업데이트: 'profile', 보기: 'show', 첨부: 'attach', 되돌리기: 'undo' };
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
