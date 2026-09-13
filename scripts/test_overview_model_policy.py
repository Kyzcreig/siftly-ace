"""CLI default and explicit override reach the nested Hermes invocation."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("extra,model,provider", [
    ([], "gpt-5.6-sol-900k", "openai-codex"),
    (["--model", "fixture-model", "--provider", "fixture-provider"], "fixture-model", "fixture-provider"),
])
def test_cli_model_reaches_hermes(monkeypatch, tmp_path, extra, model, provider):
    spec = importlib.util.spec_from_file_location("overview_writer", Path(__file__).with_name("overview_writer.py"))
    assert spec and spec.loader
    writer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(writer)
    agg = tmp_path / "aggregate.json"
    agg.write_text(json.dumps({"top_stories": []}))
    seen = []
    def run(argv, **kwargs):
        seen.append(argv)
        return SimpleNamespace(stdout="<<<OVERVIEW>>>fixture prose<<<END>>>", returncode=0)
    monkeypatch.setattr(writer.subprocess, "run", run)
    monkeypatch.setattr(writer, "lint", lambda *args: [])
    monkeypatch.setattr("sys.argv", ["overview_writer", "--agg", str(agg), *extra])
    assert writer.main() == 0
    assert len(seen) == 1
    assert seen[0][0] == "hermes"
    assert seen[0][seen[0].index("-m") + 1] == model
    assert seen[0][seen[0].index("--provider") + 1] == provider
