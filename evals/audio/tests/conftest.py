import socket

import pytest


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """The unit tests never reach the network (datasets are fetched only by real runs)."""

    def refuse(*args, **kwargs):
        raise OSError("network access is disabled in the unit tests")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


@pytest.fixture(scope="session", autouse=True)
def numba_cache(tmp_path_factory):
    """
    librosa's numba functions compile into a cache made for this test run, never into the
    environment (a cache shared there can be left in a state that crashes a later process).
    Set before anything imports numba: only the service smoke test does.
    """
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("NUMBA_CACHE_DIR", str(tmp_path_factory.mktemp("numba")))
        yield
