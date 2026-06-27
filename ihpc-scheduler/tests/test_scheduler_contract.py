import pathlib
import sys

# Anchor at ihpc-scheduler/ (parents[1]); the package root is `src` per pyproject packages=["src"].
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from src.scheduler._contract import CONTRACT_RE, contract_version


def test_contract_version_matches_the_pinned_format():
    v = contract_version()
    assert CONTRACT_RE.match(v), f"{v!r} must match {CONTRACT_RE.pattern}"


def test_contract_version_components():
    v = contract_version()
    m = CONTRACT_RE.match(v)
    assert m is not None
    version, state, build, sha = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4)
    assert version.count(".") == 2
    assert state >= 1
    assert build >= 1
    assert len(sha) >= 7


def test_rejects_old_no_build_format():
    # Symmetric with the TS guard: the pre-build legacy format must not parse.
    assert CONTRACT_RE.match("0.1.0+state2+e6883a9") is None
