/**
 * Re-fetch truncated long-form bookmarks/likes ingested before note_tweet was requested
 * (siftly-ace#9). Candidates = ~280-char text with no note_tweet in rawJson (upper bound; short
 * posts of that length come back without note_tweet and are left untouched).
 *
 *   npx tsx scripts/refetch-notetweet.ts             # dry-run: fetch (or reuse cache), report
 *   npx tsx scripts/refetch-notetweet.ts --apply     # back up the DB, then write
 *
 * Cost: GET /2/tweets?ids=<=100 per call, billed per post read. Responses are cached in
 * --responses (default ~/.hermes/state/x-bookmarks/notetweet-refetch-responses.json) so a
 * dry-run followed by --apply pays once. Idempotent: applied rows carry note_tweet and drop out
 * of the candidate set. Writes the touched tweetIds to --touched (for export-obsidian --tweet-ids).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { CANDIDATE_SQL, chunk, planRowUpdate, type CandidateRow } from '../lib/notetweet-refetch'
import type { XurlTweet } from '../lib/xurl-ingest'

const argv = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const apply = argv.includes('--apply')
const dbPath = flag('--db', process.env.SIFTLY_DB ?? 'prisma/dev.db')
const stateDir = path.join(os.homedir(), '.hermes/state/x-bookmarks')
const responsesPath = flag('--responses', path.join(stateDir, 'notetweet-refetch-responses.json'))
const touchedPath = flag('--touched', path.join(stateDir, 'notetweet-refetch-touched.txt'))
const maxCalls = Number(flag('--max-calls', '6'))
const app = flag('--app', 'siftly-ace')

type Cache = Record<string, XurlTweet | null>

async function main(): Promise<void> {
  const db = new Database(dbPath)
  const rows = db.prepare(CANDIDATE_SQL).all() as CandidateRow[]
  const cache: Cache = fs.existsSync(responsesPath) ? JSON.parse(fs.readFileSync(responsesPath, 'utf8')) : {}

  const missing = rows.map((r) => r.tweetId).filter((id) => !(id in cache))
  const batches = chunk(missing, 100)
  if (batches.length > maxCalls) {
    console.error(`refusing: ${missing.length} uncached ids need ${batches.length} calls > --max-calls ${maxCalls}`)
    process.exitCode = 2
    return
  }
  let calls = 0
  for (const ids of batches) {
    const endpoint = `/2/tweets?ids=${ids.join(',')}&tweet.fields=note_tweet,text`
    const stdout = execFileSync('xurl', ['--app', app, endpoint], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    calls++
    const body = JSON.parse(stdout) as { data?: XurlTweet[]; errors?: { resource_id?: string; value?: string }[]; title?: string }
    if (!body.data && !body.errors) throw new Error(`unexpected response: ${stdout.slice(0, 300)}`)
    for (const t of body.data ?? []) cache[t.id] = t
    for (const e of body.errors ?? []) {
      const id = e.resource_id ?? e.value
      if (id && !(id in cache)) cache[id] = null // deleted / protected / suspended
    }
    fs.mkdirSync(path.dirname(responsesPath), { recursive: true })
    fs.writeFileSync(responsesPath, JSON.stringify(cache))
  }

  const updates = rows.map((r) => planRowUpdate(r, cache[r.tweetId] ?? undefined)).filter((u) => u !== null)
  const unavailable = rows.filter((r) => cache[r.tweetId] === null).length
  const notLong = rows.length - updates.length - unavailable

  let backup = ''
  if (apply && updates.length > 0) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
    backup = `${dbPath}.bak-${ts}-notetweet`
    await db.backup(backup)
    const upd = db.prepare('UPDATE Bookmark SET text = ?, rawJson = ? WHERE id = ?')
    db.transaction(() => { for (const u of updates) upd.run(u.text, u.rawJson, u.id) })()
    fs.writeFileSync(touchedPath, updates.map((u) => u.tweetId).join('\n') + '\n')
  }

  console.log([
    apply ? 'APPLIED' : 'DRY-RUN',
    `candidates=${rows.length}`,
    `api_calls=${calls}`,
    `long_form=${updates.length}`,
    `not_long_form=${notLong}`,
    `unavailable=${unavailable}`,
    `rows_changed=${apply ? updates.length : 0}`,
    backup ? `backup=${backup}` : '',
    apply && updates.length ? `touched=${touchedPath}` : '',
  ].filter(Boolean).join(' '))
  db.close()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
