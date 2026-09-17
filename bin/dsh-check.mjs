#!/usr/bin/env node
/**
 * dsh-check — 插件一键冲突检查（静态、零副作用）。
 *
 * 复现 dsh 启动挂载时的关键失败面：所有插件在同一个 tools 注册表里注册工具，
 * 任何"跨插件重复工具名"或与 DSH 内置/保留工具名冲突都会让 profile 起不来。
 * 本工具**不 import 任何插件**（有些插件 import 期会登记常驻定时器，导致进程
 * 悬挂），而是：
 *   - 从内嵌 plugins.json 取每个插件注册的工具名；
 *   - 从目标 profile 的 package.json 依赖判断哪些套件插件已启用；
 *   - 计算：跨插件重复 / 单插件内重复 / 与 core 保留名冲突。
 *
 * 用法：
 *   node bin/dsh-check.mjs --profile web        # 检查 web profile 已启用集的冲突
 *   node bin/dsh-check.mjs --all                # 检查全部 47 个若同时启用的冲突
 *   node bin/dsh-check.mjs --only a,b,c         # 只检查指定子集
 *   node bin/dsh-check.mjs --profile web --json
 *
 * @module @qingshanjiluo/dsh-plugin-suite
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const SCOPE = '@qingshanjiluo'
// DSH 内置/常见 core 与宿主保留工具名；插件占用即视为潜在冲突（可按需增补）。
const RESERVED = new Set([
  'bash', 'read', 'write', 'edit', 'str_replace_editor', 'str-replace-editor', 'grep', 'glob', 'apply_patch',
  'todo_write', 'todo', 'subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent',
  'web_search', 'web_fetch', 'skill', 'present', 'goal', 'update_goal', 'get_goal', 'create_goal',
  'ralph', 'workflow', 'ask_user', 'ask_user_question', 'pwsh', 'run_command', 'jobs', 'job_output',
  'job_list', 'job_kill', 'kill', 'read_image', 'exit_plan_mode', 'tool_cordis',
])

function arg(name, fb) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fb }
const flags = {
  profile: arg('profile', ''),
  only: arg('only', '').split(',').map((s) => s.trim()).filter(Boolean),
  all: process.argv.includes('--all'),
  json: process.argv.includes('--json'),
}

function plugins() { return JSON.parse(readFileSync(join(PKG_ROOT, 'plugins.json'), 'utf8')) }

function profilePkgPath(profile) {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', profile, 'package.json')
}

/** 解析 profile package.json 里已声明的套件插件 short 名集合。 */
function enabledFromProfile(profile) {
  const p = profilePkgPath(profile)
  if (!existsSync(p)) throw new Error(`profile "${profile}" 无 package.json（${p}）`)
  const deps = Object.keys((JSON.parse(readFileSync(p, 'utf8')).dependencies) || {})
  const set = new Set(deps.filter((d) => d.startsWith(SCOPE + '/')).map((d) => d.slice(SCOPE.length + 1)))
  return set
}

/** 读取某 profile 的全部依赖名（含非本套件的官方/第三方插件）。 */
function allDepsFromProfile(profile) {
  const p = profilePkgPath(profile)
  if (!existsSync(p)) return []
  return Object.keys((JSON.parse(readFileSync(p, 'utf8')).dependencies) || {})
}

/**
 * 取一个插件目录里 cordis.patch.yml 声明的 loader entry id。
 * dsh 的 loader 要求 entry id 全局唯一，两个插件用同一个 id 会直接启动失败
 * （duplicate loader entry id），这跟工具名冲突是两回事，必须单独查。
 */
function loaderIds(dirName) {
  const dir = join(dirname(PKG_ROOT), dirName)
  const patch = join(dir, 'cordis.patch.yml')
  if (!existsSync(patch)) return []
  const ids = []
  const text = readFileSync(patch, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    // 只认 "- id: xxx" 这种列表项，行内其它 id 提及不算。
    const m = /^\s*-\s*id:\s*([A-Za-z0-9._-]+)\s*$/.exec(line)
    if (m) ids.push(m[1])
  }
  return ids
}

/** 已知的官方/内置 loader entry id，我方插件不得占用。 */
const RESERVED_ENTRY_IDS = new Set([
  'security-audit', 'webserver', 'tools', 'skills', 'memory', 'session', 'workspace',
  'gateway', 'agent', 'subagent', 'todo', 'goal', 'assets', 'web-app', 'base',
])

function main() {
  const all = plugins()
  const byShort = new Map(all.map((p) => [p.short, p]))
  let chosen
  if (flags.only.length) {
    const bad = flags.only.map((s) => s.startsWith(SCOPE) ? s.slice(SCOPE.length + 1) : s).filter((s) => !byShort.has(s))
    if (bad.length) { console.error('未知插件：' + bad.join(', ')); process.exit(2) }
    chosen = flags.only.map((s) => byShort.get(s.startsWith(SCOPE) ? s.slice(SCOPE.length + 1) : s))
  } else if (flags.profile) {
    const enabled = enabledFromProfile(flags.profile)
    chosen = all.filter((p) => enabled.has(p.short))
  } else {
    chosen = all // --all 或无参数：全部
  }

  const owner = new Map()
  const conflicts = []
  const reservedHits = []
  for (const p of chosen) {
    const seen = new Set()
    for (const t of p.tools) {
      if (seen.has(t)) conflicts.push({ tool: t, plugins: [p.short, p.short], kind: 'self' })
      seen.add(t)
      if (!owner.has(t)) owner.set(t, [])
      owner.get(t).push(p.short)
      if (RESERVED.has(t)) reservedHits.push({ tool: t, plugin: p.short })
    }
  }
  for (const [tool, list] of owner) if (new Set(list).size > 1) conflicts.push({ tool, plugins: [...new Set(list)], kind: 'cross' })
  // 合并 self 进 cross 展示；去重
  const seenKey = new Set(); const cf = []
  for (const c of [...conflicts, ...reservedHits.map((h) => ({ tool: h.tool, plugins: [h.plugin], kind: 'reserved' }))]) {
    const k = c.kind + '|' + c.tool + '|' + c.plugins.slice().sort().join('+')
    if (!seenKey.has(k)) { seenKey.add(k); cf.push(c) }
  }

  // ---- loader entry id 冲突（duplicate loader entry id 是启动级失败）----
  const entryOwner = new Map()
  const entryConflicts = []
  for (const p of chosen) {
    for (const id of loaderIds(p.short)) {
      if (!entryOwner.has(id)) entryOwner.set(id, [])
      entryOwner.get(id).push(p.short)
    }
  }
  // 与 profile 内其它依赖（官方层）比：官方层若有同名 entry id 也会撞。
  // 注意排除被检查插件自身的目录，否则本插件的 id 会以"外部"身份与自身相撞。
  const depsAll = flags.profile ? allDepsFromProfile(flags.profile) : []
  const chosenShorts = new Set(chosen.map((p) => p.short))
  const outsideEntryIds = new Set()
  for (const dep of depsAll) {
    if (dep.startsWith(SCOPE + '/')) continue
    const short = dep.split('/').pop() || dep
    if (chosenShorts.has(short)) continue
    for (const id of loaderIds(short)) outsideEntryIds.add(id)
  }
  for (const [id, list] of entryOwner) {
    const uniq = [...new Set(list)]
    if (uniq.length > 1) entryConflicts.push({ id, plugins: uniq, kind: 'entry-cross' })
    else if (RESERVED_ENTRY_IDS.has(id) || outsideEntryIds.has(id)) {
      entryConflicts.push({ id, plugins: uniq, kind: 'entry-reserved' })
    }
  }

  const badEntry = new Set(entryConflicts.flatMap((c) => c.plugins))
  if (flags.json) {
    process.stdout.write(JSON.stringify({ scope: flags.profile || (flags.only.length ? 'subset' : 'all'), checked: chosen.length, toolCount: [...owner.keys()].length, conflicts: cf, entryConflicts, catalog: chosen.map((p) => ({ short: p.short, pkg: p.pkg, tools: p.tools })) }, null, 2) + '\n')
  } else {
    process.stdout.write(`检查范围：${flags.profile ? 'profile ' + flags.profile : flags.only.length ? '子集' : '全部'}  |  插件 ${chosen.length} 个，去重工具名 ${owner.size} 个\n\n`)
    if (cf.length === 0) {
      process.stdout.write('未发现工具名冲突或保留名冲突：这些插件可同时启用。\n')
    } else {
      process.stdout.write('=== 冲突（会导致启动失败 / 行为异常）===\n')
      for (const c of cf) {
        const label = c.kind === 'reserved' ? '与内置/保留名' : c.kind === 'cross' ? '跨插件重复' : '插件内重复'
        process.stdout.write(`  ✗ ${c.tool}  (${label})  ←  ${c.plugins.join(', ')}\n`)
      }
      const bad = new Set(cf.flatMap((c) => c.plugins))
      const usable = chosen.filter((p) => !bad.has(p.short))
      process.stdout.write(`\n可安全同时启用：${usable.length}/${chosen.length}\n  ${usable.map((p) => p.short).join(', ')}\n`)
    }
    // loader entry id 冲突单独报：这类失败是 duplicate loader entry id，与工具名无关。
    if (entryConflicts.length) {
      process.stdout.write('\n=== loader entry id 冲突（启动级失败：duplicate loader entry id）===\n')
      for (const c of entryConflicts) {
        const label = c.kind === 'entry-cross' ? '两个插件同 id' : '与官方/保留 entry id 撞名'
        process.stdout.write(`  ✗ id=${c.id}  (${label})  ←  ${c.plugins.join(', ')}\n`)
      }
      process.stdout.write(`\n建议禁用其中之一；涉及插件：${[...badEntry].join(', ')}\n`)
    }
  }
  process.exit(cf.length || entryConflicts.length ? 1 : 0)
}

main()
