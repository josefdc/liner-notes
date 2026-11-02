import asyncio

import pytest

import preview
from preview import PreviewURLError, is_allowed_preview_url, validate_preview_url

DEEZER = (
    "https://cdnt-preview.dzcdn.net/api/1/1/f/8/c/0/f8c5dc3837912dba37c9a1ab3170cc3f.mp3"
    "?hdnea=exp=1792121561~acl=/api/1/1/f/8/c/0/f8c5dc3837912dba37c9a1ab3170cc3f.mp3*"
    "~data=user_id=0,application_id=42~hmac=f7a977d987f4663e853c6d885469b9ba"
)

ACCEPTED = [
    DEEZER,
    "https://cdns-preview-d.dzcdn.net/stream/c-deda7fa9316d9e9e880d2c6207e92260-8.mp3",
    "https://cdnt-preview.dzcdn.net:443/api/1/1/f/8/c/0/f8c5dc3837912dba37c9a1ab3170cc3f.mp3",
]

# Spotify's preview CDN. Spotify's terms restrict using its content for machine learning, so its
# previews are never analysed.
SPOTIFY = [
    "https://p.scdn.co/mp3-preview/3eb16018c2a700240e9dfb8817b6f2d041f15eb1?cid=774b29d4f13844c495f206cafdad9c86",
    "https://p.scdn.co:443/mp3-preview/abc",
]

REJECTED = [
    # Allowed domain only in the query, fragment or userinfo
    "https://evil.example/?x=dzcdn.net",
    "http://169.254.169.254/#dzcdn.net",
    "http://user:dzcdn.net@10.0.0.1/",
    "https://p.scdn.co@evil.example/a.mp3",
    "https://user@p.scdn.co/a.mp3",
    "https://evil.example/p.scdn.co/a.mp3",
    # Allowed domain as a prefix or label of another host
    "https://dzcdn.net.evil.example/a.mp3",
    "https://p.scdn.co.evil.example/a.mp3",
    "https://evildzcdn.net/a.mp3",
    "https://x.scdn.co/a.mp3",
    "https://i.scdn.co/image/abc",
    "https://dzcdn.net/a.mp3",
    # Not https
    "http://cdnt-preview.dzcdn.net/a.mp3",
    "HTTPS://cdnt-preview.dzcdn.net/a.mp3",
    "ftp://p.scdn.co/a.mp3",
    "file:///etc/passwd",
    "//p.scdn.co/a.mp3",
    # IP literals
    "https://127.0.0.1/a.mp3",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/a.mp3",
    "https://[::ffff:127.0.0.1]/a.mp3",
    "https://2130706433/a.mp3",
    "https://0x7f.0.0.1/a.mp3",
    # Uppercase, trailing dots and encoded hosts
    "https://CDNT-PREVIEW.DZCDN.NET/a.mp3",
    "https://P.SCDN.CO/a.mp3",
    "https://p.scdn.co./a.mp3",
    "https://cdnt-preview.dzcdn.net./a.mp3",
    "https://p%2escdn.co/a.mp3",
    "https://xn--p-scdn-co.example/a.mp3",
    # Ports
    "https://p.scdn.co:8443/a.mp3",
    "https://cdnt-preview.dzcdn.net:80/a.mp3",
    "https://p.scdn.co:/a.mp3",
    "https://p.scdn.co:443:80/a.mp3",
    # Characters that URL parsers disagree on
    "https://p.scdn.co\\@evil.example/a.mp3",
    "https://evil.example\\.p.scdn.co/a.mp3",
    "https://p.scdn.co /a.mp3",
    " https://p.scdn.co/a.mp3",
    "https://p.scdn.co/a.mp3\n",
    "https://p.scdn.co\t/a.mp3",
    "https://p.scdn.cо/a.mp3",
    # Empty and overlong
    "",
    "https://p.scdn.co/" + "a" * 2048,
]


@pytest.mark.parametrize("url", ACCEPTED)
def test_accepts_real_preview_urls(url):
    assert validate_preview_url(url) == url
    assert is_allowed_preview_url(url)


@pytest.mark.parametrize("url", REJECTED)
def test_rejects_crafted_urls(url):
    with pytest.raises(PreviewURLError):
        validate_preview_url(url)
    assert not is_allowed_preview_url(url)


@pytest.mark.parametrize("url", SPOTIFY)
def test_refuses_spotify_previews(url):
    with pytest.raises(PreviewURLError, match="not a supported preview CDN"):
        validate_preview_url(url)
    assert not is_allowed_preview_url(url)


def test_download_preview_refuses_a_spotify_preview_before_connecting(monkeypatch):
    async def must_not_fetch(*args, **kwargs):
        raise AssertionError("fetch_to_file called for a Spotify preview")

    monkeypatch.setattr(preview, "fetch_to_file", must_not_fetch)
    with pytest.raises(PreviewURLError):
        asyncio.run(preview.download_preview(SPOTIFY[0]))


@pytest.mark.parametrize("value", [None, 123, b"https://p.scdn.co/a.mp3"])
def test_rejects_non_strings(value):
    assert not is_allowed_preview_url(value)


def test_download_preview_validates_before_connecting(monkeypatch):
    async def must_not_fetch(*args, **kwargs):
        raise AssertionError("fetch_to_file called for a rejected URL")

    monkeypatch.setattr(preview, "fetch_to_file", must_not_fetch)
    with pytest.raises(PreviewURLError):
        asyncio.run(preview.download_preview("http://127.0.0.1:3103/redir?x=dzcdn.net"))
