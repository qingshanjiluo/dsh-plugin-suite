/**
 * One-off maintenance: add @qingshanjiluo/dsh-scheduler to the suite manifest,
 * keeping the list sorted by `short` and the file's 4-space JSON formatting.
 * @module
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', 'plugins.json')

const entry = {
  short: 'dsh-scheduler',
  pkg: '@qingshanjiluo/dsh-scheduler',
  version: '0.1.0',
  description: 'DeepSeek runtime plugin: autonomous scheduled-task planner and runner with cron/interval schedules, persistent state, and a due-prompt queue.',
  tools: [
    'sched_plan',
    'sched_create',
    'sched_list',
    'sched_update',
    'sched_remove',
    'sched_run_now',
    'sched_due',
    'sched_history',
  ],
  configKeys: ['stateDir', 'autoStart', 'tickMs', 'defaultZone', 'historyLimit', 'allowShell', 'allowHttp', 'maxLatenessMs'],
}

const list = JSON.parse(readFileSync(file, 'utf8'))
const without = list.filter(item => item.short !== entry.short)
without.push(entry)
without.sort((a, b) => (a.short < b.short ? -1 : a.short > b.short ? 1 : 0))

writeFileSync(file, `${JSON.stringify(without, null, 4)}\n`, 'utf8')
console.log(`plugins.json: ${list.length} -> ${without.length} entries`)
console.log('scheduler at index', without.findIndex(item => item.short === entry.short))
