import socket

import pytest

LOOPBACK = {"127.0.0.1", "localhost", "::1"}


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """
    The unit tests never reach the network (datasets are fetched only by real runs); a local
    server on the loopback interface, started by a test, is allowed.
    """
    connect, create_connection = socket.socket.connect, socket.create_connection

    def host_of(address):
        return address[0] if isinstance(address, tuple) else address

    def guarded_connect(self, address):
        if host_of(address) not in LOOPBACK:
            raise OSError("network access is disabled in the unit tests")
        return connect(self, address)

    def guarded_create_connection(address, *args, **kwargs):
        if host_of(address) not in LOOPBACK:
            raise OSError("network access is disabled in the unit tests")
        return create_connection(address, *args, **kwargs)

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket, "create_connection", guarded_create_connection)


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
