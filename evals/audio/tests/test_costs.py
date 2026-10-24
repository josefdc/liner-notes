"""Install and memory cost helpers (the measurement itself is a real run)."""

from evals_audio import costs


def test_librosa_adds_nothing_to_the_base_install():
    out = costs.install_cost(["librosa"])
    assert out["librosa"] == {"extra": None, "packages": [], "installedBytes": 0, "wheelBytes": 0}


def test_the_base_closure_holds_the_service_libraries():
    base = costs.closure(costs.PROJECT, set())
    assert {"librosa", "numpy", "scipy", "mirdata"} <= base
    assert "torch" not in base and "essentia-tensorflow" not in base


def test_the_wheel_for_this_platform_is_picked_from_the_lock():
    lock = {
        "package": [
            {
                "name": "demo",
                "version": "1.0+cpu",
                "wheels": [
                    {"url": "https://x/demo-1.0%2Bcpu-cp312-cp312-win_amd64.whl", "size": 1},
                    {"url": "https://x/demo-1.0%2Bcpu-py3-none-any.whl", "size": 3},
                ],
            }
        ]
    }
    assert costs.wheel_for(lock, "demo", "1.0+cpu") == {
        "url": "https://x/demo-1.0%2Bcpu-py3-none-any.whl",
        "size": 3,
    }
    assert costs.wheel_for(lock, "demo", "2.0") is None


def test_rss_is_read_from_the_process():
    assert costs.rss_bytes() > 0 and costs.peak_rss_bytes() >= costs.rss_bytes() // 2
