"""
Request guards that run before any work is done: a body size limit and token check in front of
the application, and a bounded wait for one of the analysis slots.
"""

from __future__ import annotations

import asyncio
import hmac
import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

MAX_BODY_BYTES = 16 * 1024


class ServiceBusyError(Exception):
    """No analysis slot became free in time, or too many requests are already waiting."""


class AnalysisSlots:
    """
    At most ``limit`` analyses run at once. Further requests wait up to ``wait_s`` for a slot;
    at most ``max_waiting`` may wait, and any beyond that are refused at once.

    Create it on the event loop that will use it (the application lifespan does).
    """

    def __init__(self, limit: int, max_waiting: int, wait_s: float) -> None:
        self.limit = limit
        self.max_waiting = max_waiting
        self.wait_s = wait_s
        self.waiting = 0
        self._semaphore = asyncio.Semaphore(limit)

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        if self._semaphore.locked():
            if self.waiting >= self.max_waiting:
                raise ServiceBusyError("queue full")
            self.waiting += 1
            try:
                async with asyncio.timeout(self.wait_s):
                    await self._semaphore.acquire()
            except TimeoutError as e:
                raise ServiceBusyError("no slot within the wait limit") from e
            finally:
                self.waiting -= 1
        else:
            await self._semaphore.acquire()
        try:
            yield
        finally:
            self._semaphore.release()


def token_matches(expected: str, supplied: list[bytes]) -> bool:
    """Constant-time comparison; exactly one header value must be present."""
    if len(supplied) != 1:
        return False
    return hmac.compare_digest(supplied[0], expected.encode())


class _BodyTooLargeError(Exception):
    pass


async def _send_json(send, status: int, detail: str) -> None:
    body = json.dumps({"detail": detail}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"connection", b"close"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class RequestGuardMiddleware:
    """
    Pure ASGI middleware in front of the application:

    - ``POST`` to a protected path needs the shared token (when one is configured); it is
      checked from the headers before any of the body is read.
    - Request bodies larger than ``max_body`` bytes get 413, whether the size is declared in
      Content-Length or only discovered while streaming.
    """

    def __init__(
        self,
        app,
        *,
        token: Callable[[], str],
        token_header: str,
        protected_paths: frozenset[str],
        max_body: int = MAX_BODY_BYTES,
    ) -> None:
        self.app = app
        self.token = token
        self.token_header = token_header.lower().encode()
        self.protected_paths = protected_paths
        self.max_body = max_body

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = scope.get("headers", [])
        expected = self.token()
        if expected and scope["method"] == "POST" and scope["path"] in self.protected_paths:
            supplied = [value for name, value in headers if name == self.token_header]
            if not token_matches(expected, supplied):
                await _send_json(send, 401, "Unauthorized")
                return

        lengths = [value for name, value in headers if name == b"content-length"]
        if lengths and (
            len(lengths) != 1 or not lengths[0].isdigit() or int(lengths[0]) > self.max_body
        ):
            await _send_json(send, 413, "Request body too large")
            return

        received = 0
        guard_responded = False
        app_started = False

        async def limited_receive():
            nonlocal received, guard_responded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body:
                    if not app_started and not guard_responded:
                        guard_responded = True
                        await _send_json(send, 413, "Request body too large")
                    raise _BodyTooLargeError
            return message

        async def guarded_send(message):
            nonlocal app_started
            if guard_responded:
                return  # The 413 has been sent; drop whatever the application answers.
            if message["type"] == "http.response.start":
                app_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except Exception:
            if not guard_responded:
                raise
