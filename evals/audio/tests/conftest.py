import socket

import pytest


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """The unit tests never reach the network (datasets are fetched only by real runs)."""

    def refuse(*args, **kwargs):
        raise OSError("network access is disabled in the unit tests")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
