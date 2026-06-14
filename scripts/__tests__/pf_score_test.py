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
    run_env = os.environ.copy()
    for key, value in (env or {}).items():
        if value is None:
            run_env.pop(key, None)
        else:
            run_env[key] = value
    return subprocess.run(
        ['python3', str(SCRIPT), *args],
        cwd=ROOT.parent,
        text=True,
        capture_output=True,
        env=run_env,
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
            self.assertEqual(data['affinity_mode'], 'shadow')
            self.assertEqual(data['affinity_source'], 'keyword_fallback')
            item = data['items'][0]
            self.assertEqual(item['affinity_source'], 'keyword_fallback')
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
        self.assertEqual(data['affinity_source'], 'sentinel')

    def test_embed_failure_returns_keyword_item_in_embed_and_shadow_modes(self):
        with tempfile.TemporaryDirectory() as d:
            profile = Path(d) / 'profile.json'
            candidates = Path(d) / 'candidates.json'
            profile.write_text(json.dumps(PROFILE), encoding='utf-8')
            candidates.write_text(json.dumps(CANDIDATES), encoding='utf-8')
            keyword = json.loads(run(
                str(candidates), '--profile', str(profile),
                env={'PF_WEIGHT': '30', 'PF_AFFINITY_MODE': 'keyword'},
            ).stdout)
            for mode in ('embed', 'shadow'):
                proc = run(
                    str(candidates), '--profile', str(profile),
                    env={
                        'PF_WEIGHT': '30',
                        'PF_AFFINITY_MODE': mode,
                        'PF_EMBED_AFFINITY_FORCE_FAILURE': '1',
                    },
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)
                data = json.loads(proc.stdout)
                self.assertEqual(data['affinity_mode'], mode)
                self.assertEqual(data['affinity_source'], 'keyword_fallback')
                self.assertIn('embed_error', data)
                self.assertEqual(data['items'], keyword['items'])

    def test_affinity_mode_defaults_to_shadow_for_bad_or_missing_config(self):
        with tempfile.TemporaryDirectory() as d:
            profile = Path(d) / 'profile.json'
            candidates = Path(d) / 'candidates.json'
            profile.write_text(json.dumps(PROFILE), encoding='utf-8')
            candidates.write_text(json.dumps(CANDIDATES), encoding='utf-8')
            clean_env = {'PF_AFFINITY_MODE': None, 'SIFTLY_PF_AFFINITY_MODE': None}

            for config_body in (None, '', '{not json', json.dumps({'PF_AFFINITY_MODE': 'unknown'})):
                config = Path(d) / f'config-{len(str(config_body))}.json'
                if config_body is not None:
                    config.write_text(config_body, encoding='utf-8')
                proc = run(str(candidates), '--profile', str(profile), '--config', str(config), env=clean_env)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                data = json.loads(proc.stdout)
                self.assertTrue(data['ok'], proc.stdout)
                self.assertEqual(data['affinity_mode'], 'shadow')

    def test_affinity_mode_empty_or_unknown_env_defaults_to_shadow(self):
        with tempfile.TemporaryDirectory() as d:
            profile = Path(d) / 'profile.json'
            candidates = Path(d) / 'candidates.json'
            profile.write_text(json.dumps(PROFILE), encoding='utf-8')
            candidates.write_text(json.dumps(CANDIDATES), encoding='utf-8')

            cases = [
                {'PF_AFFINITY_MODE': '', 'SIFTLY_PF_AFFINITY_MODE': 'embed'},
                {'PF_AFFINITY_MODE': 'unknown', 'SIFTLY_PF_AFFINITY_MODE': None},
            ]
            for env in cases:
                proc = run(str(candidates), '--profile', str(profile), env=env)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                data = json.loads(proc.stdout)
                self.assertTrue(data['ok'], proc.stdout)
                self.assertEqual(data['affinity_mode'], 'shadow')

    def test_weight_zero_preserves_keyword_item_scores_under_shadow(self):
        with tempfile.TemporaryDirectory() as d:
            profile = Path(d) / 'profile.json'
            candidates = Path(d) / 'candidates.json'
            profile.write_text(json.dumps(PROFILE), encoding='utf-8')
            candidates.write_text(json.dumps(CANDIDATES), encoding='utf-8')
            keyword = json.loads(run(
                str(candidates), '--profile', str(profile),
                env={'PF_WEIGHT': '0', 'PF_AFFINITY_MODE': 'keyword'},
            ).stdout)
            shadow = json.loads(run(
                str(candidates), '--profile', str(profile),
                env={'PF_WEIGHT': '0', 'PF_AFFINITY_MODE': 'shadow'},
            ).stdout)
            self.assertEqual(shadow['items'], keyword['items'])
            self.assertEqual(shadow['items'][0]['personal_fit_delta'], 0)

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
