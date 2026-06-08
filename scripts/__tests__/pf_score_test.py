#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'pf-score.py'

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
            'url': 'https://x.com/steipete/status/1',
            'title': 'Coding agents and AI devtools benchmark',
            'summary': 'A thread about Hermes and model evals',
        }
    ]
}


def run(*args, env=None):
    return subprocess.run(
        ['python3', str(SCRIPT), *args],
        cwd=ROOT.parent,
        text=True,
        capture_output=True,
        env={**os.environ, **(env or {})},
        check=False,
    )


class PfScoreTest(unittest.TestCase):
    def test_scores_candidate_and_reports_delta(self):
        with tempfile.TemporaryDirectory() as d:
            profile = Path(d) / 'profile.json'
            candidates = Path(d) / 'candidates.json'
            profile.write_text(json.dumps(PROFILE), encoding='utf-8')
            candidates.write_text(json.dumps(CANDIDATES), encoding='utf-8')
            proc = run(str(candidates), '--profile', str(profile), env={'PF_WEIGHT': '30'})
            self.assertEqual(proc.returncode, 0, proc.stderr)
            data = json.loads(proc.stdout)
            self.assertTrue(data['ok'])
            item = data['items'][0]
            self.assertGreater(item['personal_fit_raw'], 0)
            self.assertAlmostEqual(item['personal_fit_delta'], item['personal_fit_raw'] * 30, places=2)
            self.assertTrue(item['signals']['topic_hits'])
            self.assertTrue(item['signals']['author_hits'])

    def test_weight_zero_is_base_score_only(self):
        with tempfile.TemporaryDirectory() as d:
            profile = Path(d) / 'profile.json'
            candidates = Path(d) / 'candidates.json'
            profile.write_text(json.dumps(PROFILE), encoding='utf-8')
            candidates.write_text(json.dumps(CANDIDATES), encoding='utf-8')
            proc = run(str(candidates), '--profile', str(profile), env={'PF_WEIGHT': '0'})
            data = json.loads(proc.stdout)
            self.assertTrue(data['ok'])
            self.assertTrue(data['base_score_only'])
            self.assertEqual(data['pf_weight'], 0)
            self.assertEqual(data['items'][0]['personal_fit_delta'], 0)

    def test_missing_profile_exits_zero_with_fallback_sentinel(self):
        proc = run('/tmp/does-not-exist-candidates.json', '--profile', '/tmp/does-not-exist-profile.json')
        self.assertEqual(proc.returncode, 0)
        data = json.loads(proc.stdout)
        self.assertFalse(data['ok'])
        self.assertTrue(data['base_score_only'])
        self.assertIn('No such file', data['reason'])

    def test_forced_failure_self_test_exits_zero_with_fallback_sentinel(self):
        proc = run('--timeout-self-test')
        self.assertEqual(proc.returncode, 0)
        data = json.loads(proc.stdout)
        self.assertFalse(data['ok'])
        self.assertTrue(data['base_score_only'])

    def test_baseline_downshift_penalizes_low_affinity(self):
        # A low-affinity off-interest candidate should go NEGATIVE under the default
        # baseline (true up/down signal), but stay >= 0 when PF_BASELINE=0 (legacy lift).
        weak = {'candidates': [{'source': 'web', 'url': 'https://example.com/x', 'title': 'knitting patterns for beginners'}]}
        with tempfile.TemporaryDirectory() as d:
            profile = Path(d) / 'profile.json'
            candidates = Path(d) / 'candidates.json'
            profile.write_text(json.dumps(PROFILE), encoding='utf-8')
            candidates.write_text(json.dumps(weak), encoding='utf-8')
            # default baseline (0.18)
            data = json.loads(run(str(candidates), '--profile', str(profile), env={'PF_WEIGHT': '30'}).stdout)
            self.assertEqual(data['pf_baseline'], 0.18)
            self.assertLess(data['items'][0]['personal_fit_delta'], 0)
            self.assertIn('personal_fit_affinity', data['items'][0])
            # PF_BASELINE=0 restores legacy "lift everything" (never negative)
            legacy = json.loads(run(str(candidates), '--profile', str(profile), env={'PF_WEIGHT': '30', 'PF_BASELINE': '0'}).stdout)
            self.assertEqual(legacy['pf_baseline'], 0)
            self.assertGreaterEqual(legacy['items'][0]['personal_fit_delta'], 0)

    def test_baseline_preserves_delta_equals_raw_times_weight(self):
        with tempfile.TemporaryDirectory() as d:
            profile = Path(d) / 'profile.json'
            candidates = Path(d) / 'candidates.json'
            profile.write_text(json.dumps(PROFILE), encoding='utf-8')
            candidates.write_text(json.dumps(CANDIDATES), encoding='utf-8')
            data = json.loads(run(str(candidates), '--profile', str(profile), env={'PF_WEIGHT': '30', 'PF_BASELINE': '0.18'}).stdout)
            item = data['items'][0]
            self.assertAlmostEqual(item['personal_fit_delta'], item['personal_fit_raw'] * 30, places=2)
            # raw must equal affinity - baseline (clamped)
            self.assertAlmostEqual(item['personal_fit_raw'], item['personal_fit_affinity'] - 0.18, places=4)


if __name__ == '__main__':
    unittest.main()
