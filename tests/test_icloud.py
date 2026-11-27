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
                 "highlights": ["a"], "tags": [], "photo_tags": {}, "locations": {},
                 "hidden": [], "published": [], "on_work": [], "off_work": []}


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


# ---- on the Work page: on_work / off_work / new photos start off (site/meta.js <-> build.py) ----

WORK_DATA = {"on_work": ["new-on", "both"], "off_work": ["old-off", "both"]}
WORK_CASES = [  # (id, added)
    ("old", "2026-11-01T10:00:00Z"), ("old-off", "2026-11-01T10:00:00Z"), ("new", "2026-11-26T18:30:00Z"),
    ("new-on", "2026-12-01T00:00:00Z"), ("both", "2026-12-01T00:00:00Z"), ("just-before", "2026-11-26T18:29:59Z"),
    ("noadded", ""), ("junk", "yesterday"), ("offset", "2026-11-26T13:30:00-05:00"),
]


def test_on_work_matches_js_and_rules(tmp_path):
    import shutil, subprocess
    cur = tmp_path / "curation.json"
    cur.write_text(json.dumps(WORK_DATA))
    w = build.work(cur)
    py = [build.on_work(i, a, w) for i, a in WORK_CASES]
    assert dict(zip([i for i, _ in WORK_CASES], py)) == {
        "old": True, "old-off": False, "new": False, "new-on": True, "both": False, "just-before": True,
        "noadded": True, "junk": True, "offset": False}
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"on_work": "x", "off_work": [1]}))
    assert [build.on_work(i, a, build.work(bad)) for i, a in WORK_CASES][:2] == [True, True]
    node = shutil.which("node")
    if not node:
        return
    root = Path(__file__).resolve().parent.parent
    script = ("require(process.argv[1]);const M=require(process.argv[2]);const [d,c]=JSON.parse(process.argv[3]);"
              "const w=M.work(d);process.stdout.write(JSON.stringify(c.map(([i,a])=>M.onWork(i,a,w))));")
    out = subprocess.run([node, "-e", script, str(root / "site" / "titlecase.js"), str(root / "site" / "meta.js"),
                          json.dumps([WORK_DATA, WORK_CASES])], capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == py


def test_model_work_checkmark():
    script = """
    let d = M.normalize({}, cleanTitle);
    const p = {id:'n', added:'2026-12-01T00:00:00Z'}, q = {id:'o', added:'2026-01-01T00:00:00Z'};
    const before = [M.onWork(d, p), M.onWork(d, q)];
    const on = M.applyChange(d, {id:'n', work:true}, cleanTitle);
    const off = M.applyBulk(on, ['n','o'], {work:false}, cleanTitle);
    process.stdout.write(JSON.stringify([before, M.onWork(on, p), on.on_work, off.on_work, off.off_work,
      [M.onWork(off, p), M.onWork(off, q)], M.describe(d, on, 'n'), M.describeBulk(['n','o'], {work:false}),
      JSON.parse(M.serialize(d)).on_work === undefined]));
    """
    before, on_p, on_list, off_on, off_off, after, msg, bmsg, no_key = _node_model(script)
    assert before == [False, True] and on_p is True and on_list == ["n"]
    assert off_on == [] and off_off == ["n", "o"] and after == [False, False]
    assert msg == "Photo n: on Work page" and bmsg == "2 photos: off Work page" and no_key


# ---- show on site: hidden / published / drafts_from (site/meta.js <-> build.py) ----

VIS_DATA = {"hidden": ["h", "both"], "published": ["p", "both", "new-released"], "drafts_from": "2026-11-18T16:00:00Z"}
VIS_CASES = [  # (id, added)
    ("old", "2026-11-01T10:00:00Z"), ("new", "2026-11-18T16:00:00Z"), ("newer", "2026-11-19T01:02:03.456Z"),
    ("h", "2026-01-01T00:00:00Z"), ("p", "2027-01-01T00:00:00Z"), ("both", "2027-01-01T00:00:00Z"),
    ("new-released", "2026-12-01T00:00:00Z"), ("noadded", ""), ("junk", "yesterday"),
    ("offset", "2026-11-18T12:00:00-05:00"), ("offset-before", "2026-11-18T10:59:00-05:00"), ("dateonly", "2026-11-19"),
    ("last-draft", "2026-11-26T20:44:59Z"), ("site-first", "2026-11-26T20:45:00Z"), ("later", "2027-03-01T00:00:00Z"),
]


def test_visibility_matches_js_and_rules(tmp_path):
    import shutil, subprocess
    cur = tmp_path / "curation.json"
    cur.write_text(json.dumps(VIS_DATA))
    vis = build.visibility(cur)
    py = [build.is_shown(i, a, vis) for i, a in VIS_CASES]
    assert dict(zip([i for i, _ in VIS_CASES], py)) == {
        "old": True, "new": False, "newer": False, "h": False, "p": True, "both": False,
        "new-released": True, "noadded": True, "junk": True, "offset": False, "offset-before": True, "dateonly": False,
        "last-draft": False, "site-first": True, "later": True}
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"drafts_from": "soon", "hidden": "h", "published": [1]}))
    assert all(build.is_shown(i, a, build.visibility(bad)) for i, a in VIS_CASES)
    node = shutil.which("node")
    if not node:
        return
    root = Path(__file__).resolve().parent.parent
    script = ("require(process.argv[1]);const M=require(process.argv[2]);const [d,c]=JSON.parse(process.argv[3]);"
              "const v=M.visibility(d);process.stdout.write(JSON.stringify(c.map(([i,a])=>M.isShown(i,a,v))));")
    out = subprocess.run([node, "-e", script, str(root / "site" / "titlecase.js"), str(root / "site" / "meta.js"),
                          json.dumps([VIS_DATA, VIS_CASES])], capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == py


def test_model_show_hide_overrides_date_rule():
    script = """
    let d = M.normalize({drafts_from: '2026-11-18T16:00:00Z', hidden: ['a'], published: []}, cleanTitle);
    const P = (id, added) => ({id, added});
    const before = [M.isShown(d, P('a','2026-01-01')), M.isShown(d, P('n','2026-11-20T00:00:00Z'))];
    let n = M.applyChange(d, {id:'a', shown:true}, cleanTitle);
    n = M.applyChange(n, {id:'n', shown:true}, cleanTitle);
    const b = M.applyBulk(n, ['a','x'], {shown:false}, cleanTitle);
    process.stdout.write(JSON.stringify([before, M.isShown(n, P('a','2026-01-01')), M.isShown(n, P('n','2026-11-20T00:00:00Z')),
      n.hidden, n.published, b.hidden, b.published, M.describe(d, n, 'a'), M.describeBulk(['a','x'], {shown:false}),
      JSON.parse(M.serialize(n)).drafts_from, M.normalize({drafts_from:'nope'}, cleanTitle).drafts_from === undefined]));
    """
    before, a_after, n_after, hid, pub, bhid, bpub, msg, bmsg, df, bad_df = _node_model(script)
    assert before == [False, False] and a_after is True and n_after is True
    assert hid == [] and pub == ["a", "n"] and bhid == ["a", "x"] and bpub == ["n"]
    assert msg == "Photo a: shown on site" and bmsg == "2 photos: hidden from site"
    assert df == "2026-11-18T16:00:00Z" and bad_df is True


# ---- versioned assets, share pages, missing secret ----

def test_stamp_assets_only_local_js_css():
    page = ('<link rel="stylesheet" href="style.css"><script src="app.js"></script><script src="../meta.js"></script>'
            '<link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet"><a href="#top">x</a>'
            '<link rel="manifest" href="site.webmanifest"><script src="x.js?v=old"></script>')
    out = build.stamp_assets(page, "abc123")
    assert 'href="style.css?v=abc123"' in out and 'src="app.js?v=abc123"' in out and 'src="../meta.js?v=abc123"' in out
    assert 'https://fonts.googleapis.com/css2?family=X"' in out and 'href="#top"' in out and 'href="site.webmanifest"' in out
    assert 'src="x.js?v=old"' in out  # already versioned: untouched


def test_site_version_changes_with_content(tmp_path):
    (tmp_path / "a.js").write_text("one")
    v1 = build.site_version(tmp_path)
    (tmp_path / "a.js").write_text("two")
    assert build.site_version(tmp_path) != v1 and len(v1) == 10


def test_photo_page_escapes_and_points_at_own_image():
    template = (Path(__file__).resolve().parent.parent / "site" / "photo.html").read_text()
    e = {"id": "abc123", "w": 3000, "h": 2000, "caption": 'Dusk <script>alert(1)</script> & "quotes"',
         "taken": "2026-03-04T10:00:00Z", "place": FLORENCE,
         "src": [{"url": "img/abc123-480.webp", "w": 480}, {"url": "img/abc123-960.webp", "w": 960}, {"url": "img/abc123-1600.webp", "w": 1600}]}
    r = build.rights({"name": "Test Person", "copyright_start_year": 2026})
    out = build.photo_page(template, e, {"name": "Test Person", "title": "Test Person Photography"}, r,
                           "https://example.org/site", (1200, 800))
    assert "<script>" not in out and "&lt;script&gt;" in out and "&quot;quotes&quot;" in out
    assert '<meta property="og:image" content="https://example.org/site/img/abc123-og.jpg">' in out
    assert '<link rel="canonical" href="https://example.org/site/p/abc123/">' in out
    assert 'href="../../work/#photo-abc123"' in out and "Florence, Italy · Mar 2026" in out
    assert 'src="../../img/abc123-1600.webp"' in out and "{{" not in out
    assert "script-src 'none'" in out  # no scripts on share pages


def test_ci_build_fails_without_album_secret(monkeypatch, capsys):
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.delenv("ICLOUD_ALBUM", raising=False)
    monkeypatch.delenv("ICLOUD_ALBUM_TOKEN", raising=False)
    monkeypatch.setattr(sys, "argv", ["build.py"])
    monkeypatch.setattr(build, "build", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not build")))
    assert build.main() == 1
    assert "refusing to deploy an empty gallery" in capsys.readouterr().err


def test_model_bulk_highlight_on_and_off():
    script = """
    let d = M.normalize({highlights:['a']}, cleanTitle);
    const on = M.applyBulk(d, ['a','b','c'], {highlight:true}, cleanTitle);
    const off = M.applyBulk(on, ['a','c'], {highlight:false}, cleanTitle);
    process.stdout.write(JSON.stringify([on.highlights, off.highlights, M.describeBulk(['a','b'], {highlight:true}), d.highlights]));
    """
    on, off, msg, orig = _node_model(script)
    assert on == ["a", "b", "c"] and off == ["b"] and msg == "2 photos: highlighted" and orig == ["a"]


def test_model_highlights_keep_their_own_order():
    script = """
    let d = M.normalize({highlights:['a','b','c']}, cleanTitle);
    const re = M.reorderHighlights(d, ['c','a']);              // b (left out) goes last
    const again = M.applyBulk(re, ['a','d'], {highlight:true}, cleanTitle); // a keeps its place, d goes last
    const one = M.applyChange(again, {id:'c', highlight:true}, cleanTitle);  // no move
    process.stdout.write(JSON.stringify([re.highlights, again.highlights, one.highlights, d.highlights]));
    """
    re_, again, one, orig = _node_model(script)
    assert re_ == ["c", "a", "b"] and again == ["c", "a", "b", "d"] and one == again and orig == ["a", "b", "c"]


# ---- processed-image cache ----

def test_render_cache_hit_skips_the_original(tmp_path):
    src = tmp_path / "orig.jpg"
    framed(400, 300, 10).save(src)
    cache, out1, out2 = tmp_path / "cache", tmp_path / "out1", tmp_path / "out2"
    for o in (out1, out2):
        (o / "img").mkdir(parents=True)
    config = {"name": "Test Person", "copyright_start_year": 2026}
    meta = build.rights_metadata(build.rights(config))
    key = build.render_key(config)
    p = build.Photo(id="abc123", source=src, caption="", taken="2026-01-01T00:00:00Z", added="2026-02-01T00:00:00Z")
    first = build.render_cached(p, key, False, meta, out1, cache)
    assert first and first["_og"] == (400, 300) and (out1 / "img" / "abc123-og.jpg").is_file()
    assert build.cached_entry("abc123", key, cache) is not None
    # Second build: no original at all, served from the cache.
    p2 = build.Photo(id="abc123", source=None, caption="Later Title", taken=p.taken, added=p.added)
    second = build.render_cached(p2, key, False, meta, out2, cache)
    assert second["caption"] == "Later Title" and second["src"] == first["src"] and second["lqip"] == first["lqip"]
    assert sorted(f.name for f in (out2 / "img").iterdir()) == sorted(f.name for f in (out1 / "img").iterdir())
    # Different settings (e.g. a new copyright holder or year) -> cache miss.
    other = build.render_key({"name": "Someone Else", "copyright_start_year": 2026})
    assert other != key and build.cached_entry("abc123", other, cache) is None
    assert build.render_cached(p2, other, False, meta, out2, cache) is None  # needs the original again
    # A missing file also counts as a miss.
    (cache / "abc123" / first["src"][0]["url"]).unlink()
    assert build.cached_entry("abc123", key, cache) is None


def test_render_key_tracks_image_settings(monkeypatch):
    base = build.render_key({"name": "A"})
    assert build.render_key({"name": "A"}) == base
    assert build.render_key({"name": "A", "trim_white_borders": True}) != base
    monkeypatch.setattr(build, "SIZES", [480, 960])
    assert build.render_key({"name": "A"}) != base


# ---- visitor counts (GoatCounter) ----

def test_goatcounter_url_validates_code():
    assert build.goatcounter_url({"goatcounter": "alextowbin"}) == "https://alextowbin.goatcounter.com/count"
    assert build.goatcounter_url({"goatcounter": " AlexTowbin "}) == "https://alextowbin.goatcounter.com/count"
    for bad in ["", None, "a", "evil.com/x", "x\"onerror", "-start", "a" * 60, "has space"]:
        assert build.goatcounter_url({"goatcounter": bad}) == ""


def test_share_page_pixel_only_when_counting():
    template = (Path(__file__).resolve().parent.parent / "site" / "photo.html").read_text()
    e = {"id": "abc123", "w": 10, "h": 10, "caption": 'A "quoted" <title>', "taken": "", "src": [{"url": "img/abc123-480.webp", "w": 480}]}
    r = build.rights({"name": "Test Person"})
    on = build.photo_page(template, e, {"name": "Test Person", "goatcounter": "testsite"}, r, "", (10, 10))
    off = build.photo_page(template, e, {"name": "Test Person"}, r, "", (10, 10))
    assert '<img class="count" src="https://testsite.goatcounter.com/count?p=/p/abc123/&amp;t=A%20%22quoted%22%20%3Ctitle%3E' in on
    assert "goatcounter.com/count" not in off and 'class="count"' not in off and "{{" not in off


def test_main_page_number_counts_only_shown_photos():
    # Main order: h1 and h2 are hidden (new uploads sort first), the rest shown.
    script = """
    const main = ['h1','h2','a','b','c','d'];
    const shownId = (x) => !x.startsWith('h');
    const pos = (id, n) => M.mainPosFromShown(main, shownId, id, n);
    const place = (id, n) => { const ids = main.filter((x) => x !== id); ids.splice(pos(id, n) - 1, 0, id); return ids.join(''); };
    process.stdout.write(JSON.stringify([place('d', 1), place('a', 4), place('b', 2), place('c', 99), place('h1', 2),
      M.mainPosFromShown(['h1'], shownId, 'x', 3)]));
    """
    d_first, a_last, b_same, c_clamped, h1_second, none_shown = _node_model(script)
    assert d_first == "h1h2dabc"      # No. 1 = before the first shown photo, hidden ones stay ahead
    assert a_last == "h1h2bcda"       # No. 4 of 4 = after the last shown photo
    assert b_same == "h1h2abcd"       # unchanged position
    assert c_clamped == "h1h2abdc"    # beyond the end = last
    assert h1_second == "h2ah1bcd"    # a hidden photo being released lands at No. 2 among shown ones
    assert none_shown == 1


def test_model_reorder_and_undo_check():
    script = """
    const d = M.normalize({order:['h1','a','b','h2','c'], collections:[{name:'One', photos:['x','y','z']}]}, cleanTitle);
    const m = M.reorderMain(d, ['h1','a','b','h2','c'], ['c','a','b']);
    const c = M.reorderCollection(d, 'One', ['z','x']);
    const roundTrip = M.normalize(JSON.parse(M.serialize(m)), cleanTitle);
    process.stdout.write(JSON.stringify([m.order, c.collections[0].photos, d.order,
      M.sameDoc(m, roundTrip), M.sameDoc(m, d)]));
    """
    order, coll, orig, same_rt, same_other = _node_model(script)
    assert order == ["h1", "c", "a", "h2", "b"]   # hidden h1/h2 keep their slots; shown ones take the new sequence
    assert coll == ["z", "x", "y"]                 # y wasn't in the new list: kept, at the end
    assert orig == ["h1", "a", "b", "h2", "c"]     # input untouched
    assert same_rt is True and same_other is False # a saved doc read back compares equal (undo check)


def test_sitemap_lists_pages_and_share_pages():
    entries = [{"id": "abc123", "page": True, "added": "2026-11-20T10:00:00Z"},
               {"id": "hidden1", "added": "2026-11-21T10:00:00Z"},          # no share page: left out
               {"id": "nodate", "page": True},
               {"id": "../evil", "page": True}]                              # unsafe id: left out
    xml = build.sitemap_xml("https://photo.example.org/", entries)
    import re
    locs = re.findall(r"<loc>([^<]+)</loc>", xml)
    assert locs == ["https://photo.example.org/", "https://photo.example.org/work/",
                    "https://photo.example.org/collections/", "https://photo.example.org/about/",
                    "https://photo.example.org/p/abc123/", "https://photo.example.org/p/nodate/"]
    assert "<lastmod>2026-11-20</lastmod>" in xml and xml.count("<lastmod>") == 1
    assert xml.startswith('<?xml version="1.0"') and 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"' in xml


# ---- image host: Cloudflare R2 ----

def test_r2_settings_need_url_and_every_secret():
    env = {"R2_ACCOUNT_ID": "acct", "R2_ACCESS_KEY_ID": "id", "R2_SECRET_ACCESS_KEY": "secret", "R2_BUCKET": "photos"}
    cfg = {"image_url": "https://img.example.org/"}
    s = build.r2_settings(cfg, env)
    assert s == {"url": "https://img.example.org", "account": "acct", "key_id": "id", "secret": "secret", "bucket": "photos"}
    assert build.r2_settings({}, env) is None
    assert build.r2_settings({"image_url": "http://img.example.org"}, env) is None      # https only
    assert build.r2_settings(cfg, {**env, "R2_BUCKET": ""}) is None                       # a secret missing
    assert build.img_url("img/a-480.webp", "https://img.example.org", "../../") == "https://img.example.org/img/a-480.webp"
    assert build.img_url("img/a-480.webp", "", "../../") == "../../img/a-480.webp"
    assert build.img_origin("https://img.example.org") == "https://img.example.org"


class FakeBucket:
    def __init__(self, objects):
        self.objects = dict(objects)  # key -> size
        self.puts, self.deleted = [], []

    def get_paginator(self, _name):
        bucket = self

        class P:
            def paginate(self, Bucket, Prefix):
                yield {"Contents": [{"Key": k, "Size": v} for k, v in bucket.objects.items() if k.startswith(Prefix)]}
        return P()

    def put_object(self, Bucket, Key, Body, ContentType, CacheControl):
        self.puts.append((Key, ContentType, CacheControl))
        self.objects[Key] = len(Body)

    def delete_objects(self, Bucket, Delete):
        for o in Delete["Objects"]:
            self.deleted.append(o["Key"])
            self.objects.pop(o["Key"], None)


def test_sync_images_uploads_changes_and_deletes_removed(tmp_path):
    img = tmp_path / "img"
    img.mkdir()
    (img / "a-480.webp").write_bytes(b"x" * 10)   # unchanged
    (img / "b-480.webp").write_bytes(b"y" * 20)   # changed size
    (img / "c-og.jpg").write_bytes(b"z" * 5)      # new
    (img / "notes.txt").write_text("ignored")
    fake = FakeBucket({"img/a-480.webp": 10, "img/b-480.webp": 19, "img/gone-480.webp": 7, "other/keep": 1})
    stats = build.sync_images(fake, "photos", img)
    assert stats == {"uploaded": 2, "deleted": 1, "kept": 1}
    puts = {p[0]: p[1] for p in fake.puts}  # uploads run in parallel: order varies
    assert sorted(puts) == ["img/b-480.webp", "img/c-og.jpg", "robots.txt"] and fake.puts[-1][0] == "robots.txt"
    assert puts["img/c-og.jpg"] == "image/jpeg" and puts["img/b-480.webp"] == "image/webp"
    assert fake.deleted == ["img/gone-480.webp"] and "other/keep" in fake.objects


def test_sync_images_refuses_mass_delete(tmp_path):
    img = tmp_path / "img"
    img.mkdir()
    (img / "a-480.webp").write_bytes(b"x")
    fake = FakeBucket({f"img/p{i}-480.webp": 3 for i in range(10)})
    stats = build.sync_images(fake, "photos", img)
    assert stats["deleted"] == 0 and fake.deleted == [] and len(fake.objects) == 12  # 10 + a + robots


def test_build_points_pages_at_the_image_host(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "OUT", tmp_path / "_site")
    monkeypatch.setattr(build, "CURATION", tmp_path / "none.json")
    monkeypatch.setenv("SITE_URL", "https://photo.example.org")
    build.build(build.demo_photos(2), {"name": "Test"}, use_cache=False, img_base="https://img.example.org")
    out = tmp_path / "_site"
    photos = json.loads((out / "photos.json").read_text())
    assert all(s["url"].startswith("https://img.example.org/img/") for p in photos for s in p["src"])
    home = (out / "index.html").read_text()
    assert "img-src 'self' data: https://img.example.org" in home
    assert '"contentUrl": "https://img.example.org/img/' in home or 'https://img.example.org/img/' in home
    share = next(out.glob("p/*/index.html")).read_text()
    assert 'src="https://img.example.org/img/' in share and "https://img.example.org/img/" in share.split("og:image")[1][:200]
    assert "img-src 'self' data: https://img.example.org" in (out / "edit" / "index.html").read_text()


def test_image_host_ready_checks_the_public_address():
    class R:
        def __init__(self, code, text):
            self.status_code, self.text = code, text
    fake = FakeBucket({})
    assert build.image_host_ready(fake, "photos", "https://img.example.org", get=lambda u, timeout: R(200, "User-agent: *"))
    assert fake.puts[0][0] == "robots.txt"
    assert not build.image_host_ready(fake, "photos", "https://img.example.org", get=lambda u, timeout: R(404, ""))

    def boom(u, timeout):
        raise OSError("no such host")
    assert not build.image_host_ready(fake, "photos", "https://img.example.org", get=boom)


# ---- faster big batches: parallel download / processing ----

def test_prerender_in_parallel_matches_one_at_a_time(tmp_path):
    import hashlib
    photos = []
    for i in range(3):
        f = tmp_path / f"o{i}.jpg"
        framed(600 + i * 40, 400, 12).save(f)
        photos.append(build.Photo(id=f"par{i}", source=f, added="2026-05-01T00:00:00Z"))
    photos.append(build.Photo(id="nofile", source=None))             # cached-only photo: skipped
    cfg = {"name": "Test"}
    key, meta = build.render_key(cfg), build.rights_metadata(build.rights(cfg))

    def digest(d):
        h = hashlib.sha256()
        for p in sorted(d.rglob("*")):
            if p.is_file():
                h.update(p.relative_to(d).as_posix().encode() + p.read_bytes())
        return h.hexdigest()
    for p in photos:
        build.render_to_cache(p, key, False, meta, tmp_path / "serial")
    assert build.prerender(photos, key, False, meta, tmp_path / "par", workers=2) == 3
    assert digest(tmp_path / "serial") == digest(tmp_path / "par")
    assert build.prerender(photos, key, False, meta, tmp_path / "par", workers=2) == 0  # all cached now


def test_download_album_fetches_in_parallel_keeps_order_and_drops_failures(tmp_path, monkeypatch):
    items = [{"checksum": f"c{i}", "url": f"https://example.org/{i}", "caption": "", "taken": "", "added": ""}
             for i in range(6)]
    monkeypatch.setattr(build, "CACHE", tmp_path)
    monkeypatch.setattr(build, "fetch_cloudkit_album", lambda token: ("Album", items))

    def fake_fetch(url, dest):
        if url.endswith("/3"):
            return False                                   # one download fails
        dest.write_bytes(b"x")
        return True
    monkeypatch.setattr(build, "fetch_original", fake_fetch)
    skip_id = build.hashlib.sha1(b"c1").hexdigest()[:12]
    photos = build.download_album("1TOKEN", skip=lambda pid: pid == skip_id)
    ids = [build.hashlib.sha1(f"c{i}".encode()).hexdigest()[:12] for i in (0, 1, 2, 4, 5)]
    assert [p.id for p in photos] == ids                    # album order, failed one dropped
    assert photos[1].source is None and all(p.source for i, p in enumerate(photos) if i != 1)
