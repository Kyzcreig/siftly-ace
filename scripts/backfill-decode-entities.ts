/**
 * One-shot backfill: decode HTML entities in Bookmark.text for rows ingested before
 * tweetBodyText() decoded at the boundary (2026-10-04). Idempotent. Dry-run by default.
 *   npx tsx scripts/backfill-decode-entities.ts            # report only
 *   npx tsx scripts/backfill-decode-entities.ts --apply    # write (back up prisma/dev.db first)
 * Rows whose rawJson lacks note_tweet and whose text is ~280 chars may still be TRUNCATED
 * long-form posts; that needs a re-fetch, not a decode — reported, not touched.
 */
import Database from 'better-sqlite3'
import { decodeXmlEntities } from '../lib/xurl-ingest'

const apply = process.argv.includes('--apply')
const db = new Database(process.env.SIFTLY_DB ?? 'prisma/dev.db')
const rows = db.prepare(`SELECT id, text FROM Bookmark WHERE text LIKE '%&gt;%' OR text LIKE '%&lt;%' OR text LIKE '%&amp;%' OR text LIKE '%&quot;%' OR text LIKE '%&#39;%'`).all() as { id: string; text: string }[]
let changed = 0
const upd = db.prepare('UPDATE Bookmark SET text = ? WHERE id = ?')
const tx = db.transaction(() => {
  for (const r of rows) {
    const d = decodeXmlEntities(r.text)
    if (d !== r.text) { changed++; if (apply) upd.run(d, r.id) }
  }
})
tx()
console.log(`${apply ? 'APPLIED' : 'DRY-RUN'}: ${rows.length} candidate rows, ${changed} would change`)
process.exit(0)
