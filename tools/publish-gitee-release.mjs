#!/usr/bin/env node
// 把安装包上传到 Gitee 的「发行版」（releases），用于国内下载 / 应用内自动更新的 mirror。
//
// 令牌来源（按顺序）：
//   1) 环境变量 GITEE_TOKEN
//   2) %USERPROFILE%\.gitee-token（由 tools\set-gitee-token.ps1 保存）
//
// 用法（用产品自带的 node 跑）：
//   node tools\publish-gitee-release.mjs --owner menhuayuchen --repo phone-access-download \
//        --tag v1.0.10 --name "手机远程 v1.0.10" --notes-file release-notes.md \
//        --asset "dist\PhoneAccess-Setup-v1.0.10.exe" --asset-name PhoneAccess-Setup-v1.0.10.exe
//
//   加 --dry-run 只校验令牌/仓库和打印计划，不上传。
//   加 --verify 上传后再用 HTTP 头验证下载地址可用（不带 cookie）。
//
// 注意：这个脚本只负责「传文件」；要不要发版由人决定（见 docs/发布与更新.md 的发版铁律）。
import { readFileSync, openAsBlob } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

const API = 'https://gitee.com/api/v5';
const args = process.argv.slice(2);
function arg(name, def = '') {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const flag = (name) => args.includes('--' + name);

const owner = arg('owner', 'menhuayuchen');
const repo = arg('repo', 'phone-access-download');
const tag = arg('tag');
const name = arg('name', tag);
const notesFile = arg('notes-file');
const asset = arg('asset');
const assetName = arg('asset-name', asset ? basename(asset) : '');
const dryRun = flag('dry-run');
const verify = flag('verify');

if (!tag || !asset) {
  console.error('用法：node publish-gitee-release.mjs --owner <o> --repo <r> --tag <vX.Y.Z> --asset <文件> [--name 标题] [--notes-file 说明.md] [--dry-run] [--verify]');
  process.exit(2);
}

function readToken() {
  if (process.env.GITEE_TOKEN) return process.env.GITEE_TOKEN.trim();
  const p = join(homedir(), '.gitee-token');
  try { return readFileSync(p, 'utf8').trim(); } catch { return ''; }
}
const token = readToken();
if (!token) {
  console.error('[x] 找不到 Gitee 令牌：先运行 tools\\设置Gitee令牌.cmd（或设环境变量 GITEE_TOKEN）');
  process.exit(1);
}

// 令牌一律走 access_token 参数（Gitee v5 的标准方式），但**不打印**任何带令牌的 URL
function apiUrl(path, extra = {}) {
  const u = new URL(API + path);
  u.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}
async function api(path, opts = {}) {
  const r = await fetch(apiUrl(path), { ...opts, headers: { 'User-Agent': 'PhoneAccess-Gitee-Publish', ...(opts.headers || {}) } });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { }
  return { status: r.status, ok: r.ok, json, text };
}
function fail(msg, detail) {
  console.error('[x] ' + msg + (detail ? '\n' + String(detail).slice(0, 800) : ''));
  process.exit(1);
}

(async () => {
  // 1) 校验令牌和仓库
  const me = await api('/user');
  if (!me.ok || !me.json || !me.json.login) fail('令牌无效（或缺少 user_info 权限）', me.text);
  const rp = await api(`/repos/${owner}/${repo}`);
  if (!rp.ok) fail(`访问仓库失败：${owner}/${repo}（令牌需要 projects 权限，且仓库要存在）`, rp.text);
  console.log(`[i] 账号 ${me.json.login} · 仓库 ${owner}/${repo}（默认分支 ${rp.json.default_branch || 'master'}）`);

  // 2) 找该 tag 的发行版；没有就创建
  let release = null;
  const byTag = await api(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (byTag.ok && byTag.json && byTag.json.id) release = byTag.json;
  if (!release) {
    const list = await api(`/repos/${owner}/${repo}/releases?per_page=100`);
    if (list.ok && Array.isArray(list.json)) release = list.json.find((x) => x && x.tag_name === tag) || null;
  }
  if (release) {
    console.log(`[i] 已存在发行版：${tag}（id=${release.id}）`);
  } else if (dryRun) {
    console.log(`[i] 将创建发行版：${tag}（dry-run，不实际操作）`);
  } else {
    const notes = notesFile ? readFileSync(notesFile, 'utf8') : '';
    const body = new URLSearchParams({
      tag_name: tag,
      name: name || tag,
      body: notes,
      target_commitish: rp.json.default_branch || 'master',
      prerelease: 'false'
    });
    const created = await api(`/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!created.ok) fail('创建发行版失败（常见原因：tag 已存在但没发行版、或权限不足）', created.text);
    release = created.json;
    console.log(`[OK] 已创建发行版：${tag}（id=${release.id}）`);
  }

  // 3) 上传附件
  if (dryRun) {
    console.log(`[i] 将上传附件：${assetName}（${asset}）`);
    console.log(`[i] 完成后下载地址：https://gitee.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`);
    return;
  }
  if (!release || !release.id) fail('拿不到发行版 id，无法上传');
  let blob;
  try { blob = await openAsBlob(asset); } catch { blob = new Blob([readFileSync(asset)]); }
  const fd = new FormData();
  fd.append('file', blob, assetName);
  const up = await fetch(apiUrl(`/repos/${owner}/${repo}/releases/${release.id}/attach_files`), {
    method: 'POST',
    headers: { 'User-Agent': 'PhoneAccess-Gitee-Publish' },
    body: fd
  });
  const upText = await up.text();
  let upJson = null;
  try { upJson = upText ? JSON.parse(upText) : null; } catch { }
  if (!up.ok) fail('上传附件失败', upText);
  const item = Array.isArray(upJson) ? upJson[0] : upJson;
  const url = (item && item.browser_download_url)
    || `https://gitee.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
  console.log('[OK] 附件已上传：' + (item && item.name ? item.name : assetName));
  console.log('[i] 下载地址：' + url);

  // 4) 可选：不带 cookie 验证一次（模拟客户/服务端下载）
  if (verify) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'PhoneAccess-UpdateCheck' }, redirect: 'follow' });
      console.log(`[i] 验证：HTTP ${r.status}，content-type=${r.headers.get('content-type')}，content-length=${r.headers.get('content-length')}`);
      if (!r.ok) fail('下载地址验证失败（HTTP ' + r.status + '）');
    } catch (e) {
      fail('验证下载地址时出错：' + e.message);
    }
  }
})().catch((e) => fail('脚本异常：' + (e && e.message)));
