"""Offline tests for the iCloud shared-album parsing (no network)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build  # noqa: E402


class FakeResp:
    def __init__(self, status, data):
        self.status_code, self._data = status, data

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class FakeSession:
    def __init__(self):
        self.headers, self.calls = {}, []

    def post(self, url, json, timeout):
        self.calls.append(url)
        if url.startswith("https://p01-") and url.endswith("webstream"):
            return FakeResp(330, {"X-Apple-MMe-Host": "p99-sharedstreams.icloud.com"})
        if url.endswith("webstream"):
            return FakeResp(200, {"streamName": "Portfolio", "photos": [
                {"photoGuid": "g1", "caption": " Dunes ", "dateCreated": "2026-01-02T00:00:00Z",
                 "batchDateCreated": "2026-03-01T00:00:00Z", "derivatives": {
                     "342": {"checksum": "small1", "width": "342", "height": "228"},
                     "2049": {"checksum": "big1", "width": "2048", "height": "1365"}}},
                {"photoGuid": "g2", "mediaAssetType": "video", "derivatives": {
                     "720p": {"checksum": "vid"}, "PosterFrame": {"checksum": "pf"}}},
            ]})
        if url.endswith("webasseturls"):
            return FakeResp(200, {"items": {
                "big1": {"url_location": "cvws.icloud-content.com", "url_path": "/B/abc"}}})
        raise AssertionError(url)


def test_partition():
    assert build.icloud_base_url("A1abc").startswith("https://p01-sharedstreams.icloud.com/A1abc/")
    assert build.icloud_base_url("B0z").startswith("https://p61-")

def test_fetch_follows_redirect_picks_largest_and_skips_video():
    s = FakeSession()
    name, items = build.fetch_icloud_album("A1token", session=s)
    assert name == "Portfolio"
    assert any("p99-sharedstreams" in c for c in s.calls)
    assert len(items) == 1
    it = items[0]
    assert it["checksum"] == "big1"
    assert it["caption"] == "Dunes"
    assert it["url"] == "https://cvws.icloud-content.com/B/abc"
    assert it["added"] == "2026-03-01T00:00:00Z"
