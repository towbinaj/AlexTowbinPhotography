"""Offline tests for the iCloud album readers and image helpers (no network)."""
import base64
import sys
import json
from pathlib import Path

from PIL import Image

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


def test_parse_album_accepts_urls_and_tokens():
    assert build.parse_album("https://photos.icloud.com/shared/album/0abcDEF123") == "0abcDEF123"
    assert build.parse_album("https://www.icloud.com/sharedalbum/#B0aBcDeFgHiJkL") == "B0aBcDeFgHiJkL"
    assert build.parse_album("  B0aBcDeFgHiJkL;extra ") == "B0aBcDeFgHiJkL"


# ---- new-style shared collections (CloudKit) ----

ZONE = {"zoneName": "SharedCollection-TEST", "ownerRecordName": "_owner", "zoneType": "REGULAR_CUSTOM_ZONE"}


def res(checksum, url="https://cvws.icloud-content.com/B/x/${f}?o=1"):
    return {"type": "ASSETID", "value": {"fileChecksum": checksum, "downloadURL": url}}


def master(name, item_type="public.jpeg", **fields):
    f = {"itemType": {"value": item_type}, "resOriginalFileType": {"value": item_type},
         "resOriginalRes": res("orig-" + name), "resJPEGMedRes": res("med-" + name)}
    f.update(fields)
    return {"recordName": name, "recordType": "CPLMaster", "fields": f}


def asset(name, master_name, added, by="_owner", **fields):
    f = {"masterRef": {"value": {"recordName": master_name}}, "addedDate": {"value": added},
         "assetDate": {"value": 1754400000000}}
    f.update(fields)
    return {"recordName": name, "recordType": "CPLAsset", "fields": f,
            "created": {"userRecordName": by}}


class FakeCK:
    def __init__(self, records):
        self.headers, self.records, self.queries = {}, records, []

    def post(self, url, params=None, data=None, timeout=None):
        if url.endswith("/public/records/resolve"):
            return FakeResp(200, {"results": [{
                "zoneID": ZONE,
                "share": {"fields": {"cloudkit.title": {"value": "Portfolio"}}},
                "anonymousPublicAccess": {"token": "TOK", "databasePartition": "https://p01-ckdatabasews.icloud.com:443"},
            }]})
        assert url.startswith("https://p01-ckdatabasews.icloud.com:443/") and params["publicAccessAuthToken"] == "TOK"
        self.queries.append(data)
        import json
        rank = json.loads(data)["query"]["filterBy"][1]["fieldValue"]["value"]
        return FakeResp(200, {"records": self.records if rank == 0 else []})


def test_cloudkit_album_picks_edits_skips_video_and_hidden():
    caption = base64.b64encode("Pantheon".encode()).decode()
    recs = [
        master("m1"), asset("a1", "m1", 1700000000000, captionEnc={"value": caption}),
        master("m2"), asset("a2", "m2", 1700000001000, resJPEGFullRes=res("edited-2")),
        master("m3", item_type="com.apple.quicktime-movie"), asset("a3", "m3", 1700000002000),
        master("m4"), asset("a4", "m4", 1700000003000, isHidden={"value": 1}),
        master("m5", item_type="public.mystery-raw"), asset("a5", "m5", 1700000004000),
        master("m6"), asset("a6", "m6", 1700000005000, by="_stranger"),   # joined via link and added a photo
    ]
    s = FakeCK(recs)
    name, items = build.fetch_cloudkit_album("0abc", session=s)
    assert name == "Portfolio"
    by = {i["checksum"]: i for i in items}
    # original, edited render, fallback for odd originals; the stranger's photo is ignored
    assert set(by) == {"orig-m1", "edited-2", "med-m5"}
    assert by["orig-m1"]["caption"] == "Pantheon"
    assert by["orig-m1"]["url"] == "https://cvws.icloud-content.com/B/x/photo.jpg?o=1"
    assert by["orig-m1"]["added"] == "2023-11-14T22:13:20Z"
    assert len(s.queries) == 2  # second page comes back empty and stops paging


# ---- classic shared albums (sharedstreams) ----

class FakeStreams:
    def __init__(self):
        self.headers, self.calls = {}, []

    def post(self, url, params=None, data=None, timeout=None):
        self.calls.append(url)
        if url.startswith("https://p01-") and url.endswith("webstream"):
            return FakeResp(330, {"X-Apple-MMe-Host": "p99-sharedstreams.icloud.com"})
        if url.endswith("webstream"):
            return FakeResp(200, {"streamName": "Portfolio", "photos": [
                {"photoGuid": "g1", "caption": " Dunes ", "dateCreated": "2026-01-02T00:00:00Z",
                 "batchDateCreated": "2026-03-01T00:00:00Z", "derivatives": {
                     "342": {"checksum": "small1", "width": "342", "height": "228"},
                     "2049": {"checksum": "big1", "width": "2048", "height": "1365"}}},
                {"photoGuid": "g2", "mediaAssetType": "video", "derivatives": {"720p": {"checksum": "vid"}}},
            ]})
        if url.endswith("webasseturls"):
            return FakeResp(200, {"items": {"big1": {"url_location": "loc1", "url_path": "/B/abc"}},
                                  "locations": {"loc1": {"scheme": "https", "hosts": ["cvws.icloud-content.com"]}}})
        raise AssertionError(url)


def test_partition():
    assert build.icloud_base_url("A1abc").startswith("https://p01-sharedstreams.icloud.com/A1abc/")
    assert build.icloud_base_url("B0z").startswith("https://p61-")


def test_sharedstream_follows_redirect_picks_largest_and_skips_video():
    s = FakeStreams()
    name, items = build.fetch_sharedstream_album("A1token", session=s)
    assert name == "Portfolio"
    assert any("p99-sharedstreams" in c for c in s.calls)
    assert [i["checksum"] for i in items] == ["big1"]
    assert items[0]["url"] == "https://cvws.icloud-content.com/B/abc"
    assert items[0]["caption"] == "Dunes"


# ---- image helpers ----

def framed(w=1000, h=1300, border=30, color=(60, 70, 80)):
    im = Image.new("RGB", (w, h), (255, 255, 255))
    im.paste(color, (border, border, w - border, h - border))
    return im


def test_trim_removes_uniform_white_frame():
    out = build.trim_white_border(framed())
    assert 920 <= out.width <= 945 and 1220 <= out.height <= 1245


def test_trim_leaves_bright_sky_alone():
    im = Image.new("RGB", (1000, 1000), (250, 250, 250))
    im.paste((40, 40, 40), (0, 300, 1000, 1000))  # bright band touches 3 edges, dark ground touches the bottom
    assert build.trim_white_border(im).size == (1000, 1000)


def test_trim_leaves_borderless_photo_alone():
    assert build.trim_white_border(Image.new("RGB", (800, 600), (90, 90, 90))).size == (800, 600)


def test_render_strips_camera_metadata_and_adds_copyright(tmp_path):
    src = tmp_path / "in.jpg"
    exif = Image.Exif()
    exif[0x0112] = 6            # rotate 90°
    exif[0x010F] = "TestCam"    # Make
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"
    framed(400, 300, 10).save(src, exif=exif)
    (tmp_path / "img").mkdir()
    r = build.rights({"name": "Test Person", "copyright_start_year": 2020})
    assert r["notice"].startswith("\u00a9 2020\u2013") and r["notice"].endswith("Test Person. All rights reserved.")
    entry = build.render_images(build.Photo(id="x", source=src), tmp_path, trim=False,
                                meta=build.rights_metadata(r))
    assert (entry["w"], entry["h"]) == (300, 400)  # orientation baked in
    assert entry["located"] is False               # GPS ref without coordinates
    for s in entry["src"]:
        with Image.open(tmp_path / s["url"]) as im:
            ex = im.getexif()
            assert set(ex) == {0x013B, 0x8298}          # only Artist + Copyright survive
            assert ex[0x013B] == "Test Person"
            assert ex[0x8298].startswith("Copyright 2020-") and ex[0x8298].isascii()
            assert not ex.get_ifd(0x8825)               # no GPS
            assert b"xmpRights:Marked=\"True\"" in im.info.get("xmp", b"")


def test_json_ld_is_safe_and_credits_holder():
    r = build.rights({"name": "Test Person"})
    entries = [{"w": 3, "h": 4, "caption": "</script><b>", "src": [{"url": "img/a-1.webp"}, {"url": "img/a-2.webp"}]}]
    out = build.json_ld(entries, {"title": "T", "instagram": "someone"}, r, "https://example.org/site")
    assert "</" not in out
    import json
    d = json.loads(out)
    img = d["image"][0]
    assert img["creator"]["name"] == "Test Person" and img["copyrightNotice"] == r["notice"]
    assert img["contentUrl"] == "https://example.org/site/img/a-2.webp"
    assert img["license"] == "https://example.org/site/#rights"


# ---- titles.json (written by the site's title editor) ----

def test_load_titles_tolerates_junk(tmp_path):
    f = tmp_path / "titles.json"
    assert build.load_titles(f) == {}                       # missing
    f.write_text("not json")
    assert build.load_titles(f) == {}
    f.write_text('["a list"]')
    assert build.load_titles(f) == {}
    f.write_text('{"abc": "  Wacker   Drive \\n", "def": "", "ghi": 5, "jkl": "' + "x" * 300 + '"}')
    t = build.load_titles(f)
    assert t["abc"] == "Wacker Drive" and "def" not in t and "ghi" not in t and len(t["jkl"]) == 200


def test_titles_override_album_captions():
    entries = [{"id": "a", "caption": "from album"}, {"id": "b", "caption": ""}, {"id": "c", "caption": "keep"}]
    build.apply_titles(entries, {"a": "Edited", "b": "New"})
    assert [e["caption"] for e in entries] == ["Edited", "New", "keep"]
    # the page falls back to these if the live data drops the title
    assert [e.get("album_caption") for e in entries] == ["from album", "", None]


# ---- curation.json: titles + chosen order ----

def test_load_curation_falls_back_to_legacy_titles_and_dedupes_order(tmp_path):
    cur, legacy = tmp_path / "curation.json", tmp_path / "titles.json"
    assert build.load_curation(cur, legacy) == ({}, [])
    legacy.write_text('{"a": "Old", "b": "Old b"}')
    cur.write_text('{"titles": {"b": "New b", "c": 3}, "order": ["x", "y", "x", 7, "z"]}')
    titles, order = build.load_curation(cur, legacy)
    assert titles == {"b": "New B"}          # once curation.json exists, the old file is ignored
    assert order == ["x", "y", "z"]
    cur.write_text("garbage")
    assert build.load_curation(cur, legacy) == ({"a": "Old", "b": "Old B"}, [])


def test_apply_order_places_known_photos_and_puts_new_ones_first():
    P = lambda i: build.Photo(id=i, source=None)
    auto = [P("n2"), P("n1"), P("c"), P("a"), P("b")]       # automatic (newest-added) order
    out = build.apply_order(auto, ["a", "b", "c", "gone"])  # "gone" was removed from the album
    assert [p.id for p in out] == ["n2", "n1", "a", "b", "c"]
    assert build.apply_order(auto, []) == auto


# ---- title case (same cases are checked against site/titlecase.js) ----

def test_title_case_cases():
    import json
    cases = json.loads((Path(__file__).parent / "titlecase_cases.json").read_text())
    for raw, want in cases:
        assert build.title_case(raw) == want, raw


def test_saved_titles_are_title_cased(tmp_path):
    cur = tmp_path / "curation.json"
    cur.write_text('{"titles": {"a": "shine a light"}, "order": []}')
    assert build.load_curation(cur, tmp_path / "none.json")[0] == {"a": "Shine a Light"}


def test_title_case_js_matches_python():
    import json, shutil, subprocess
    node = shutil.which("node")
    if not node:
        import pytest
        pytest.skip("node not installed")
    root = Path(__file__).resolve().parent.parent
    script = ("const tc=require(process.argv[1]);const cases=require(process.argv[2]);"
              "process.stdout.write(JSON.stringify(cases.map(([r])=>tc(r))));")
    out = subprocess.run([node, "-e", script, str(root / "site" / "titlecase.js"),
                          str(root / "tests" / "titlecase_cases.json")],
                         capture_output=True, text=True, check=True).stdout
    cases = json.loads((root / "tests" / "titlecase_cases.json").read_text())
    assert json.loads(out) == [want for _, want in cases]


# ---- data repo: curation.json is untrusted input ----

UNTRUSTED_TITLES = [
    "shine a light",
    "  bad\u0000title\u202eevil\u200b\n\ttabs  ",
    "<script>alert(1)</script>",
    "x" * 300,
    "😀" * 250,
    "\ufeffnyc at night",
    "\u0085next\u2028line",
]


def test_untrusted_curation_is_cleaned(tmp_path):
    cur = tmp_path / "curation.json"
    cur.write_text(json.dumps({
        "titles": {"a": UNTRUSTED_TITLES[1], "b": "x" * 300, "c": ["list"], "": "empty id",
                   "i" * 65: "long id", "d": "\u200b"},
        "order": ["a"] * 3 + [{"x": 1}, "i" * 65, "b"],
    }))
    titles, order = build.load_curation(cur, tmp_path / "none.json")
    assert titles == {"a": "Bad Title Evil Tabs", "b": "X" + "x" * 199}
    assert order == ["a", "b"]


def test_data_settings_only_accepts_owner_slash_repo():
    s = build.data_settings({"data_repo": "towbin/Photo-Data"})
    assert s["data_url"] == "https://raw.githubusercontent.com/towbin/Photo-Data/main/curation.json"
    for bad in ["", None, "nope", "a/b/c", "evil.com/x?y", "a/b#c", "../x"]:
        assert build.data_settings({"data_repo": bad}) == {"data_repo": "", "data_url": ""}


def test_clean_title_js_matches_python():
    import shutil, subprocess
    node = shutil.which("node")
    if not node:
        import pytest
        pytest.skip("node not installed")
    root = Path(__file__).resolve().parent.parent
    script = ("const {cleanTitle}=require(process.argv[1]);"
              "process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]).map(cleanTitle)));")
    out = subprocess.run([node, "-e", script, str(root / "site" / "titlecase.js"), json.dumps(UNTRUSTED_TITLES)],
                         capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == [build.clean_title(t) for t in UNTRUSTED_TITLES]


def test_location_is_a_flag_never_coordinates(tmp_path):
    src = tmp_path / "gps.jpg"
    exif = Image.Exif()
    gps = exif.get_ifd(0x8825)
    gps.update({1: "N", 2: (41.0, 52.0, 30.0), 3: "W", 4: (87.0, 37.0, 50.0)})
    framed(200, 150, 5).save(src, exif=exif)
    (tmp_path / "img").mkdir()
    entry = build.render_images(build.Photo(id="g", source=src), tmp_path, trim=False)
    assert entry["located"] is True
    assert set(entry) == {"id", "w", "h", "caption", "taken", "added", "lqip", "src", "located", "_im"}
    with Image.open(tmp_path / entry["src"][0]["url"]) as im:
        assert not im.getexif().get_ifd(0x8825)


# ---- editor app data model (site/edit/model.js, run in node) ----

def _node_model(script, *args):
    import shutil, subprocess
    node = shutil.which("node")
    if not node:
        import pytest
        pytest.skip("node not installed")
    root = Path(__file__).resolve().parent.parent
    pre = (f"const cleanTitle=require({json.dumps(str(root / 'site' / 'titlecase.js'))}).cleanTitle;"
           f"const M=require({json.dumps(str(root / 'site' / 'edit' / 'model.js'))});")
    out = subprocess.run([node, "-e", pre + script, *args], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def test_model_normalize_rejects_junk():
    raw = {"titles": {"a": "shine a light", "b": 5, "": "x", "c": "‮"},
           "order": ["a", "a", 3, "b"],
           "collections": [{"name": "chicago at night", "photos": ["a", "b", "a"]},
                           {"name": "CHICAGO AT NIGHT", "photos": ["c"]},      # duplicate name
                           {"name": "Other", "photos": ["b", "d"]},              # b already in one
                           {"name": "", "photos": ["e"]}, "junk", {"name": "Empty", "photos": []}],
           "highlights": ["a", None, "a"], "extra": "<script>"}
    d = _node_model("process.stdout.write(JSON.stringify(M.normalize(JSON.parse(process.argv[1]),cleanTitle)))",
                    json.dumps(raw))
    assert d == {"titles": {"a": "Shine a Light"}, "order": ["a", "b"],
                 "collections": [{"name": "Chicago at Night", "photos": ["a", "b"]},
                                 {"name": "Other", "photos": ["d"]}],
                 "highlights": ["a"], "tags": [], "photo_tags": {}, "locations": {}}


def test_model_apply_change_moves_between_collections_and_reorders():
    script = """
    let d = M.normalize({titles:{}, order:[], collections:[{name:'One', photos:['a','b','c']}], highlights:[]}, cleanTitle);
    const out = [];
    let n = M.applyChange(d, {id:'b', collection:'two'}, cleanTitle);              // new collection
    out.push(n.collections);
    n = M.applyChange(n, {id:'c', collection:'One', collectionPos:1}, cleanTitle);  // reorder within
    out.push(n.collections);
    n = M.applyChange(n, {id:'b', collection:''}, cleanTitle);                      // remove: empty one dropped
    out.push(n.collections);
    n = M.applyChange(n, {id:'a', highlight:true, title:'  hello   world '}, cleanTitle);
    n = M.applyChange(n, {id:'c', mainPos:99, mainIds:['a','b','c','d']}, cleanTitle);
    out.push([n.highlights, n.titles, n.order, M.describe(d, n, 'a')]);
    out.push(d.collections);                                                        // input untouched
    process.stdout.write(JSON.stringify(out));
    """
    a, b, c, rest, orig = _node_model(script)
    assert a == [{"name": "One", "photos": ["a", "c"]}, {"name": "Two", "photos": ["b"]}]
    assert b[0] == {"name": "One", "photos": ["c", "a"]}
    assert c == [{"name": "One", "photos": ["c", "a"]}]
    assert rest[0] == ["a"] and rest[1] == {"a": "Hello World"} and rest[2] == ["a", "b", "d", "c"]
    assert rest[3].startswith('Photo a: title "Hello World"') and "highlighted" in rest[3]
    assert orig == [{"name": "One", "photos": ["a", "b", "c"]}]


def test_model_order_matches_build_rule():
    script = """const L=['n2','n1','c','a','b'].map(id=>({id}));
    process.stdout.write(JSON.stringify([M.orderPhotos(L,['a','b','c','gone']).map(p=>p.id), M.orderPhotos(L,[]).map(p=>p.id)]));"""
    placed, auto = _node_model(script)
    P = lambda i: build.Photo(id=i, source=None)
    want = [p.id for p in build.apply_order([P(i) for i in ["n2", "n1", "c", "a", "b"]], ["a", "b", "c", "gone"])]
    assert placed == want and auto == ["n2", "n1", "c", "a", "b"]


# ---- tags and places (site/meta.js <-> build.py) ----

FLORENCE = {"level": "city", "gid": 3176959, "city": "Florence", "region": "Tuscany", "country": "Italy", "cc": "IT"}
PLACES_IN = [
    FLORENCE,
    {"level": "city", "gid": 4164138, "city": "Miami", "region": "Florida", "country": "United States", "cc": "US"},
    {"level": "city", "gid": 1.0, "city": "No Region", "country": "Somewhere", "cc": "SW"},
    {"level": "region", "code": "IT.16", "region": "Tuscany", "country": "Italy", "cc": "IT", "lat": 43.7},
    {"level": "country", "country": "Italy", "cc": "IT", "city": "ignored"},
    {"level": "city", "gid": 5, "city": "  Spaced\u202e  Out ", "country": "X" * 100, "cc": "XX"},
    {"level": "street", "country": "Italy", "cc": "IT"},
    {"level": "city", "gid": True, "city": "Bool", "country": "Italy", "cc": "IT"},
    {"level": "city", "gid": -1, "city": "Neg", "country": "Italy", "cc": "IT"},
    {"level": "region", "code": "IT.16\"><", "region": "Tuscany", "country": "Italy", "cc": "IT"},
    {"level": "country", "country": "Italy", "cc": "it"},
    "Florence", None, [FLORENCE],
]
TAGS_IN = ["street photography", "  NYC  at night ", "x" * 60, "\u200b", "<b>bold</b>"]


def _node_meta():
    import shutil, subprocess
    node = shutil.which("node")
    if not node:
        import pytest
        pytest.skip("node not installed")
    root = Path(__file__).resolve().parent.parent
    script = ("require(process.argv[1]);const M=require(process.argv[2]);const [places,tags]=JSON.parse(process.argv[3]);"
              "const cp=places.map(M.cleanPlace);"
              "process.stdout.write(JSON.stringify([cp,cp.map(M.placeLabel),tags.map(M.cleanTag)]));")
    out = subprocess.run([node, "-e", script, str(root / "site" / "titlecase.js"), str(root / "site" / "meta.js"),
                          json.dumps([PLACES_IN, TAGS_IN])], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def test_places_and_tags_match_js():
    js_places, js_labels, js_tags = _node_meta()
    py_places = [build.clean_place(p) for p in PLACES_IN]
    assert js_places == py_places
    assert js_labels == [build.place_label(p) for p in py_places]
    assert js_tags == [build.clean_tag(t) for t in TAGS_IN]
    assert js_labels[:5] == ["Florence, Italy", "Miami, Florida, United States", "No Region, Somewhere",
                             "Tuscany, Italy", "Italy"]
    assert py_places[3] == {"level": "region", "code": "IT.16", "region": "Tuscany", "country": "Italy", "cc": "IT"}
    assert all(p is None for p in py_places[6:])


def test_load_meta_keeps_only_library_tags_and_valid_places(tmp_path):
    cur = tmp_path / "curation.json"
    cur.write_text(json.dumps({
        "tags": ["street", "Night", "NIGHT", 7],
        "photo_tags": {"a": ["STREET", "bogus", "night", "street"], "b": "street", "c": ["nope"]},
        "locations": {"a": FLORENCE, "b": {"level": "city", "city": "x"}},
    }))
    tags, places = build.load_meta(cur)
    assert tags == {"a": ["Street", "Night"]}
    assert places == {"a": FLORENCE}
    assert build.load_meta(tmp_path / "missing.json") == ({}, {})


def test_json_ld_has_keywords_and_city_level_place():
    entries = [{"id": "a", "w": 10, "h": 10, "caption": "", "src": [{"url": "img/a.webp", "w": 10, "h": 10}],
                "tags": ["Street", "Night"], "place": FLORENCE}]
    r = build.rights({"name": "Test Person"})
    data = json.loads(build.json_ld(entries, {"name": "Test Person"}, r, "https://example.org/site"))
    img = data["image"][0]
    assert img["keywords"] == "Street, Night"
    assert img["contentLocation"] == {"@type": "Place", "name": "Florence, Italy"}


def test_model_tag_library_rename_merges_and_delete_clears():
    script = """
    let d = M.normalize({tags:['Street','Night','Rain'], photo_tags:{a:['Street','Night'], b:['Night','Rain']}}, cleanTitle);
    const r1 = M.renameTag(d, 'night', 'Evening');           // plain rename
    const r2 = M.renameTag(d, 'Night', 'street');            // onto existing: merge
    const r3 = M.deleteTag(d, 'RAIN');
    const r4 = M.applyChange(d, {id:'c', tags:['brand new', 'street'], place: {level:'country', country:'Italy', cc:'IT'}}, cleanTitle);
    process.stdout.write(JSON.stringify([r1.tags, r1.photo_tags, r2.tags, r2.photo_tags, r3.tags, r3.photo_tags,
      r4.tags, r4.photo_tags.c, r4.locations.c, M.placesInUse(r4).length, d.tags]));
    """
    r1t, r1p, r2t, r2p, r3t, r3p, r4t, r4c, r4l, n, orig = _node_model(script)
    assert r1t == ["Street", "Evening", "Rain"] and r1p == {"a": ["Street", "Evening"], "b": ["Evening", "Rain"]}
    assert r2t == ["Street", "Rain"] and r2p == {"a": ["Street"], "b": ["Street", "Rain"]}
    assert r3t == ["Street", "Night"] and r3p == {"a": ["Street", "Night"], "b": ["Night"]}
    assert r4t == ["Street", "Night", "Rain", "Brand New"] and r4c == ["Brand New", "Street"]
    assert r4l == {"level": "country", "country": "Italy", "cc": "IT"} and n == 1
    assert orig == ["Street", "Night", "Rain"]


def test_load_collections_matches_site_rules(tmp_path):
    cur = tmp_path / "curation.json"
    cur.write_text(json.dumps({"collections": [
        {"name": "florence at night", "photos": ["a", "b", "a", "gone"]},
        {"name": "FLORENCE AT NIGHT", "photos": ["c"]},          # duplicate name
        {"name": "Other", "photos": ["b", "c"]},                  # b already used
        {"name": "", "photos": ["d"]}, {"name": "Empty", "photos": []}, "junk",
    ]}))
    assert build.load_collections(cur, known={"a", "b", "c", "d"}) == [
        {"name": "Florence at Night", "photos": ["a", "b"]}, {"name": "Other", "photos": ["c"]}]
    assert build.load_collections(tmp_path / "missing.json") == []


def test_load_highlights_dedupes_and_keeps_known(tmp_path):
    cur = tmp_path / "curation.json"
    cur.write_text(json.dumps({"highlights": ["a", "a", 3, "gone", "b", "x" * 65]}))
    assert build.load_highlights(cur, known={"a", "b"}) == ["a", "b"]
    cur.write_text('{"highlights": "a"}')
    assert build.load_highlights(cur) == []


def test_model_bulk_tags_collection_and_place():
    script = """
    let d = M.normalize({tags:['Street','Night'], photo_tags:{a:['Street'], b:['Night']},
      collections:[{name:'Old', photos:['a']}, {name:'Series', photos:['c','b']}]}, cleanTitle);
    const flo = {level:'city', gid:3176959, city:'Florence', region:'Tuscany', country:'Italy', cc:'IT'};
    const n = M.applyBulk(d, ['a','b','x'], {addTags:['night','brand new'], removeTags:['Street'], collection:'series', place: flo}, cleanTitle);
    const r = M.applyBulk(n, ['a','x'], {collection:'', place:null}, cleanTitle);
    process.stdout.write(JSON.stringify([n.tags, n.photo_tags, n.collections, Object.keys(n.locations),
      r.collections, Object.keys(r.locations), M.describeBulk(['a','b','x'], {addTags:['Night'], collection:'Series', place: flo}), d.photo_tags]));
    """
    tags, ptags, colls, locs, colls2, locs2, msg, orig = _node_model(script)
    assert tags == ["Street", "Night", "Brand New"]
    assert ptags == {"a": ["Night", "Brand New"], "b": ["Night", "Brand New"], "x": ["Night", "Brand New"]}
    # b already in Series keeps its place; a and x are appended in the order given; empty "Old" is dropped
    assert colls == [{"name": "Series", "photos": ["c", "b", "a", "x"]}]
    assert locs == ["a", "b", "x"]
    assert colls2 == [{"name": "Series", "photos": ["c", "b"]}] and locs2 == ["b"]
    assert msg == '3 photos: tags +Night; collection "Series"; location Florence, Italy'
    assert orig == {"a": ["Street"], "b": ["Night"]}
