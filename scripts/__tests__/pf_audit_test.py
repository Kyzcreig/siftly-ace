#!/usr/bin/env python3
"""Tests for scripts/pf-audit.py — Wave 5 Feature 2 (RC3)."""
import json
import os
import subprocess
import tempfile
import textwrap
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / 'pf-audit.py'

PROFILE = {
    'corpus_size': {'bookmarks': 2, 'likes': 1},
    'top_topics': [
        {'name': 'ai-ml', 'weight': 10, 'segment': 'brief-relevant'},
        {'name': 'dev-tools', 'weight': 8, 'segment': 'brief-relevant'},
    ],
    'high_signal_authors': [{'handle': 'steipete', 'saves': 10, 'weight': 10}],
    'favorite_formats': ['format:single', 'is_thread', 'has_video'],
    'downrank_patterns': ['contrast:boring'],
}

CANDIDATES = {
    'candidates': [
        {
            'source': 'x',
            'id': 'tweet-1',
            'url': 'https://x.com/steipete/status/1',
            'title': 'Coding agents and AI devtools benchmark SECRETWORD',
            'summary': 'A thread about Hermes and model evals',
        }
    ]
}


def run(*args, env=None):
    return subprocess.run(
        ['python3', str(AUDIT), *args],
        cwd=ROOT.parent,
        text=True,
        capture_output=True,
        env={**os.environ, **(env or {})},
        check=False,
    )


class PfAuditTest(unittest.TestCase):
    def _setup(self, d):
        profile = Path(d) / 'profile.json'
        config = Path(d) / 'config.json'
        candidates = Path(d) / 'candidates.json'
        audit_dir = Path(d) / 'pf-audit'
        profile.write_text(json.dumps(PROFILE), encoding='utf-8')
        candidates.write_text(json.dumps(CANDIDATES), encoding='utf-8')
        return profile, config, candidates, audit_dir

    def test_fired_writes_artifact_and_log(self):
        with tempfile.TemporaryDirectory() as d:
            profile, config, candidates, audit_dir = self._setup(d)
            config.write_text(json.dumps({'PF_WEIGHT': 30, 'PF_BASELINE': 0.18}), encoding='utf-8')
            proc = run(str(candidates), '--brief', 'x-feed-brief', '--profile', str(profile),
                       '--config', str(config), '--audit-dir', str(audit_dir))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            # stdout re-emits pf-score's JSON unchanged
            emitted = json.loads(proc.stdout)
            self.assertTrue(emitted['ok'])
            # durable artifact exists
            files = list(audit_dir.glob('x-feed-brief-*.json'))
            self.assertEqual(len(files), 1)
            audit = json.loads(files[0].read_text())
            self.assertTrue(audit['fired'])
            self.assertEqual(audit['reason'], 'fired')
            self.assertEqual(audit['pf_weight'], 30)
            self.assertEqual(audit['pf_baseline'], 0.18)
            self.assertEqual(audit['n_items'], 1)
            # log.jsonl summary line
            log = (audit_dir / 'log.jsonl').read_text().strip().splitlines()
            self.assertEqual(len(log), 1)
            summary = json.loads(log[0])
            self.assertTrue(summary['fired'])
            self.assertEqual(summary['brief'], 'x-feed-brief')

    def test_rc3_no_raw_text_in_artifact(self):
        with tempfile.TemporaryDirectory() as d:
            profile, config, candidates, audit_dir = self._setup(d)
            config.write_text(json.dumps({'PF_WEIGHT': 30}), encoding='utf-8')
            run(str(candidates), '--brief', 'x-feed-brief', '--profile', str(profile),
                '--config', str(config), '--audit-dir', str(audit_dir))
            artifact = next(audit_dir.glob('x-feed-brief-*.json')).read_text()
            # The candidate's title/summary text must NOT leak into the durable artifact.
            self.assertNotIn('SECRETWORD', artifact)
            self.assertNotIn('Hermes and model evals', artifact)
            # but the id + scores + top_signals ARE present
            audit = json.loads(artifact)
            item = audit['items'][0]
            self.assertEqual(item['id'], 'tweet-1')
            self.assertIn('top_signals', item)
            self.assertLessEqual(len(item['top_signals']), 2)
            self.assertNotIn('title', item)
            self.assertNotIn('url', item)

    def test_kill_switch_records_fired_false(self):
        with tempfile.TemporaryDirectory() as d:
            profile, config, candidates, audit_dir = self._setup(d)
            config.write_text(json.dumps({'PF_WEIGHT': 0}), encoding='utf-8')
            proc = run(str(candidates), '--brief', 'morning-digest', '--profile', str(profile),
                       '--config', str(config), '--audit-dir', str(audit_dir))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            audit = json.loads(next(audit_dir.glob('morning-digest-*.json')).read_text())
            self.assertFalse(audit['fired'])
            self.assertIn('kill-switch', audit['reason'])

    def test_declined_when_profile_missing(self):
        with tempfile.TemporaryDirectory() as d:
            _, config, candidates, audit_dir = self._setup(d)
            config.write_text(json.dumps({'PF_WEIGHT': 30}), encoding='utf-8')
            missing = Path(d) / 'nope.json'
            proc = run(str(candidates), '--brief', 'x-feed-brief', '--profile', str(missing),
                       '--config', str(config), '--audit-dir', str(audit_dir))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            audit = json.loads(next(audit_dir.glob('x-feed-brief-*.json')).read_text())
            self.assertFalse(audit['fired'])
            self.assertNotEqual(audit['reason'], 'fired')
            self.assertNotEqual(audit['reason'], 'timeout')

    def test_timeout_classified_distinctly_and_still_emits_sentinel(self):
        with tempfile.TemporaryDirectory() as d:
            profile, config, candidates, audit_dir = self._setup(d)
            config.write_text(json.dumps({'PF_WEIGHT': 30}), encoding='utf-8')
            # A fake slow pf-score that sleeps past our timeout.
            slow = Path(d) / 'slow-pf-score.py'
            slow.write_text(textwrap.dedent('''
                import time, sys
                time.sleep(5)
                print('{"ok": true, "items": []}')
            '''), encoding='utf-8')
            proc = run(str(candidates), '--brief', 'x-feed-brief', '--profile', str(profile),
                       '--config', str(config), '--audit-dir', str(audit_dir),
                       '--pf-score', str(slow), '--timeout', '0.5')
            self.assertEqual(proc.returncode, 0, proc.stderr)
            # Sentinel emitted so the brief continues
            emitted = json.loads(proc.stdout)
            self.assertFalse(emitted['ok'])
            self.assertTrue(emitted.get('base_score_only'))
            audit = json.loads(next(audit_dir.glob('x-feed-brief-*.json')).read_text())
            self.assertFalse(audit['fired'])
            self.assertEqual(audit['reason'], 'timeout')

    def test_prune_removes_old_artifacts_and_log_lines(self):
        with tempfile.TemporaryDirectory() as d:
            profile, config, candidates, audit_dir = self._setup(d)
            config.write_text(json.dumps({'PF_WEIGHT': 30}), encoding='utf-8')
            audit_dir.mkdir(parents=True, exist_ok=True)
            # Seed an old artifact (mtime 10 days ago) and an old log line.
            old_file = audit_dir / 'x-feed-brief-2020-01-01T0000Z.json'
            old_file.write_text('{}', encoding='utf-8')
            old_time = time.time() - 10 * 86400
            os.utime(old_file, (old_time, old_time))
            old_ts = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
            (audit_dir / 'log.jsonl').write_text(
                json.dumps({'ts': old_ts, 'brief': 'x-feed-brief', 'fired': True}) + '\n',
                encoding='utf-8')
            # Run with default 7-day prune.
            run(str(candidates), '--brief', 'x-feed-brief', '--profile', str(profile),
                '--config', str(config), '--audit-dir', str(audit_dir))
            self.assertFalse(old_file.exists(), 'old artifact should be pruned')
            log_lines = (audit_dir / 'log.jsonl').read_text().strip().splitlines()
            # only the fresh run's line remains; old one pruned
            for line in log_lines:
                rec = json.loads(line)
                self.assertNotEqual(rec['ts'], old_ts)
            self.assertGreaterEqual(len(log_lines), 1)


if __name__ == '__main__':
    unittest.main()
