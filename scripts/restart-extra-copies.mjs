#!/usr/bin/env node
// Runs after `pm2 restart ecosystem.config.cjs` (see the pm:restart script).
// That command restarts only the apps named in ecosystem.config.cjs. A host may
// also run other pm2 copies of this checkout, started by hand under another
// name with their own env. This restarts those too, by pm_id and WITHOUT
// --update-env, so each keeps the env it was started with. Spec: specs/002.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const norm = (p) => {
  if (!p) return ''
  const r = path.resolve(p)
  try {
    return realpathSync(r)
  } catch {
    return r
  }
}

/** pm_ids of processes running from `cwd` that ecosystem.config.cjs does not name. */
export function selectExtraCopies(jlist, cwd, ecosystemNames) {
  const here = norm(cwd)
  const named = new Set(ecosystemNames)
  return jlist
    .filter((p) => norm(p?.pm2_env?.pm_cwd) === here && !named.has(p.name))
    .map((p) => p.pm_id)
}

/** `pm2 jlist` stdout → array; skips any banner line printed before the JSON. */
export function parseJlist(stdout) {
  const lines = String(stdout).split('\n')
  const start = lines.findIndex((l) => l.trimStart().startsWith('['))
  if (start === -1) throw new Error('pm2 jlist returned no JSON array')
  return JSON.parse(lines.slice(start).join('\n'))
}

/** Returns the process exit code: 0 when every extra copy restarted (or there were none). */
export function restartExtraCopies({ jlist, run, cwd, names, log = console.log }) {
  const ids = selectExtraCopies(parseJlist(jlist()), cwd, names)
  if (ids.length === 0) {
    log('No other pm2 copies of this checkout to restart.')
    return 0
  }
  let failed = 0
  for (const id of ids) {
    try {
      run(['restart', String(id)])
    } catch (err) {
      failed++
      log(`pm2 restart ${id} failed: ${err?.message ?? err}`)
    }
  }
  return failed ? 1 : 0
}

if (process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const eco = createRequire(import.meta.url)(path.join(root, 'ecosystem.config.cjs'))
  process.exitCode = restartExtraCopies({
    jlist: () => execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    run: (args) => execFileSync('pm2', args, { stdio: 'inherit' }),
    cwd: root,
    names: (eco.apps ?? []).map((a) => a.name),
  })
}
