#!/usr/bin/env node
/**
 * publish-all — 发布全部 @qingshanjiluo/dsh-* 包到 npm 的维护脚本。
 *
 * 用法：
 *   node scripts/publish-all.mjs --pack-only            # 只做本地打包校验（无需登录），验证 47 包发布就绪
 *   node scripts/publish-all.mjs --yes                  # 真正发布（需已登录 npmjs 且拥有 @qingshanjiluo scope）
 *   node scripts/publish-all.mjs --yes --src <dir>      # 指定包含 dsh-* 子目录的根目录
 *
 * 关键约束：
 *   - 一律显式 --registry https://registry.npmjs.org（本机默认常是 npmmirror 只读镜像，不能发布）。
 *   - scoped 公共包必须 --access public。
 *   - 发布前先 `npm whoami --registry npmjs.org` 校验登录；未登录直接中止并打印步骤。
 *   - 已存在的包（npm view 命中）跳过，便于断点续发。
 *   - 需要 NPM_TOKEN 时用 --token-env 从环境变量注入（写到临时 .npmrc）。
 *
 * @module publish-all
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REGISTRY = 'https://registry.npmjs.org'
const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SRC = resolve(HERE, '..', '..') // 本文件在 <src>/dsh-plugin-suite/scripts → src 为 <src>

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const flags = {
  packOnly: process.argv.includes('--pack-only'),
  yes: process.argv.includes('--yes') || process.argv.includes('-y'),
  tokenEnv: process.argv.includes('--token-env'),
  src: resolve(arg('src', DEFAULT_SRC)),
  dryRun: process.argv.includes('--dry-run'),
}

/** 收集 src 下所有 dsh-* 且 package.json 为 @qingshanjiluo scope 的目录。 */
function collect(src) {
  const out = []
  for (const name of readdirSync(src)) {
    const dir = join(src, name)
    if (!name.startsWith('dsh-') || !statSync(dir).isDirectory()) continue
    const pj = join(dir, 'package.json')
    if (!existsSync(pj)) continue
    let json
    try { json = readFileSync(pj, 'utf8'); json = JSON.parse(json) } catch { continue }
    if (json.name && json.name.startsWith('@qingshanjiluo/')) out.push({ name, dir, pkg: json.name, version: json.version })
  }
  return out.sort((a, b) => a.pkg.localeCompare(b.pkg))
}

function npm(args, cwd, extraEnv) {
  const r = spawnSync('npm', args, { cwd, encoding: 'utf8', env: extraEnv ? { ...process.env, ...extraEnv } : process.env, maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

function alreadyPublished(pkg, userconfig) {
  const args = ['view', pkg, 'version', '--registry', REGISTRY]
  if (userconfig) args.push('--userconfig', userconfig)
  const r = npm(args, process.cwd(), undefined)
  return r.code === 0 ? r.out.trim() : null
}

function main() {
  const pkgs = collect(flags.src)
  console.log(`发现 ${pkgs.length} 个 @qingshanjiluo/* 包于 ${flags.src}\n`)
  if (!pkgs.length) { console.error('没有可发布的包'); process.exit(1) }

  // 1) 本地打包校验（pack --dry-run，无需登录）
  let packFail = 0
  for (const p of pkgs) {
    const r = npm(['pack', '--dry-run'], p.dir)
    const files = /total files:\s*(\d+)/.exec(r.out)
    if (r.code !== 0) { packFail++; console.log(`  ✗ pack ${p.pkg} — ${r.out.trim().split('\n').slice(-1)[0]}`) }
    else console.log(`  ✓ pack ${p.pkg}@${p.version} (${files ? files[1] : '?'} files)`)
  }
  console.log(`\n打包校验：${pkgs.length - packFail}/${pkgs.length} 就绪`)
  if (packFail) { console.error('有包打包失败，已中止发布。'); process.exit(1) }

  if (flags.packOnly) { console.log('\n[--pack-only] 到此为止（未发布）。'); return }
  if (!flags.yes) { console.log('\n未加 --yes：这是发布动作，需要显式确认。先运行 `--pack-only` 校验，或追加 --yes 发布。'); process.exit(3) }

  // 2) 解析鉴权：可选 NPM_TOKEN → 临时 .npmrc；否则要求已 npm login 到 npmjs
  let userconfig = ''
  const env = {}
  if (flags.tokenEnv) {
    const token = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN
    if (!token) { console.error('--token-env 需要环境变量 NPM_TOKEN'); process.exit(1) }
    const tmp = mkdtempSync(join(tmpdir(), 'npmpub-'))
    userconfig = join(tmp, '.npmrc')
    writeFileSync(userconfig, `//registry.npmjs.org/:_authToken=${token}\nregistry=${REGISTRY}\n`, 'utf8')
    env.NPM_CONFIG_USERCONFIG = userconfig
  }
  const whoArgs = ['whoami', '--registry', REGISTRY]
  if (userconfig) whoArgs.push('--userconfig', userconfig)
  const who = npm(whoArgs, process.cwd())
  if (who.code !== 0) {
    cleanup(userconfig)
    console.error(`\n未能以 npmjs 身份登录：${who.out.trim().split('\n').slice(-1)[0]}\n请先：\n  npm login --registry ${REGISTRY}\n或设置 NPM_TOKEN 并使用 --token-env。`)
    process.exit(2)
  }
  const user = who.out.trim()
  console.log(`\n已登录 npmjs：${user}。开始发布（scoped 公共包，--access public）…\n`)

  // 3) 顺序发布，跳过已存在
  let pub = 0, skip = 0; const failed = []
  try {
    for (const p of pkgs) {
      const cur = alreadyPublished(p.pkg, userconfig)
      if (cur) { skip++; console.log(`  = 跳过 ${p.pkg}（已存在 ${cur}）`); continue }
      if (flags.dryRun) { console.log(`  (dry-run) publish ${p.pkg}@${p.version}`); continue }
      const pubArgs = ['publish', '--access', 'public', '--registry', REGISTRY]
      if (userconfig) pubArgs.push('--userconfig', userconfig)
      const r = npm(pubArgs, p.dir)
      if (r.code === 0) { pub++; console.log(`  ✓ 发布 ${p.pkg}@${p.version}`) }
      else { failed.push(p.pkg); console.log(`  ✗ 发布 ${p.pkg} — ${r.out.trim().split('\n').slice(-2).join(' ')}`) }
    }
  } finally { cleanup(userconfig) }

  console.log(`\n发布完成：新发 ${pub}、跳过 ${skip}、失败 ${failed.length}${failed.length ? '：' + failed.join(', ') : ''}`)
  if (failed.length) process.exit(1)
}

function cleanup(userconfig) { if (userconfig) { try { rmSync(dirname(userconfig), { recursive: true, force: true }) } catch { /* ignore */ } } }

main()
