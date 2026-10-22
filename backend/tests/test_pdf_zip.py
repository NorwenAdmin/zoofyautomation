# GET /api/facturen/pdfs.zip behind the UI's "Download selected". Called as a function against real
# Postgres (like the rest of this suite) with UPLOADS_DIR pointed at a temp dir, so the archive's
# *contents* can be checked with the stdlib zipfile — something an HTTP-level test can't do cheaply.
import io
import zipfile
from datetime import date

import pytest
from fastapi import HTTPException

from app.models import Factuur, User
from app.routers import facturen as facturen_router
from app.routers.facturen import download_pdfs_zip

OWNER = User(email="owner@example.nl", password_hash="x", name="Owner")
DEMO = User(email="demo@example.nl", password_hash="x", name="Demo", is_demo=True)


@pytest.fixture(autouse=True)
def uploads_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(facturen_router, "UPLOADS_DIR", tmp_path)
    return tmp_path


async def _factuur(db, uploads, number, totaal, pdf: bytes | None = b"%PDF-1.4 default"):
    row = Factuur(factuur=number, totaal=totaal)
    db.add(row)
    await db.commit()
    if pdf is not None:
        row.pdf_url = f"/uploads/gmail/facturen/{row.id}.pdf"
        (uploads / f"{row.id}.pdf").write_bytes(pdf)
        await db.commit()
    return row


def _open(response) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(response.body))


async def test_zip_holds_the_requested_pdfs_named_by_invoice_number_with_exact_bytes(db_session, uploads_dir):
    a = await _factuur(db_session, uploads_dir, "2026-1001", 10, b"%PDF-1.4 first")
    b = await _factuur(db_session, uploads_dir, "2026-1002", 20, b"%PDF-1.4 second")

    response = await download_pdfs_zip(ids=[a.id, b.id], db=db_session, current_user=OWNER)

    archive = _open(response)
    assert sorted(archive.namelist()) == ["2026-1001.pdf", "2026-1002.pdf"]
    assert archive.read("2026-1001.pdf") == b"%PDF-1.4 first"
    assert archive.read("2026-1002.pdf") == b"%PDF-1.4 second"


async def test_response_is_a_non_cacheable_zip_attachment(db_session, uploads_dir):
    a = await _factuur(db_session, uploads_dir, "2026-1001", 10)
    response = await download_pdfs_zip(ids=[a.id], db=db_session, current_user=OWNER)

    assert response.media_type == "application/zip"
    assert response.headers["content-disposition"] == f'attachment; filename="invoices-{date.today().isoformat()}.zip"'
    assert response.headers["cache-control"] == "private, no-store"


async def test_only_the_requested_rows_are_included(db_session, uploads_dir):
    wanted = await _factuur(db_session, uploads_dir, "2026-1001", 10)
    await _factuur(db_session, uploads_dir, "2026-1002", 20)

    response = await download_pdfs_zip(ids=[wanted.id], db=db_session, current_user=OWNER)
    assert _open(response).namelist() == ["2026-1001.pdf"]


async def test_the_same_invoice_number_with_two_amounts_gets_two_distinct_files(db_session, uploads_dir):
    # (factuur, totaal) is the unique key, so a corrected amount is a second row with its own PDF.
    first = await _factuur(db_session, uploads_dir, "2026-1001", 10, b"%PDF original")
    second = await _factuur(db_session, uploads_dir, "2026-1001", 12, b"%PDF corrected")

    response = await download_pdfs_zip(ids=[first.id, second.id], db=db_session, current_user=OWNER)

    archive = _open(response)
    assert sorted(archive.namelist()) == sorted(["2026-1001.pdf", f"2026-1001-{second.id}.pdf"])
    assert archive.read("2026-1001.pdf") == b"%PDF original"
    assert archive.read(f"2026-1001-{second.id}.pdf") == b"%PDF corrected"


async def test_unsafe_characters_in_an_invoice_number_cannot_shape_the_archive_entry_name(db_session, uploads_dir):
    a = await _factuur(db_session, uploads_dir, '2026/12 3"45', 10)
    b = await _factuur(db_session, uploads_dir, "../../etc/passwd", 20)

    response = await download_pdfs_zip(ids=[a.id, b.id], db=db_session, current_user=OWNER)

    names = _open(response).namelist()
    assert sorted(names) == [".._.._etc_passwd.pdf", "2026_12_3_45.pdf"]
    assert all("/" not in n and "\\" not in n for n in names)


async def test_a_repeated_id_is_included_once(db_session, uploads_dir):
    a = await _factuur(db_session, uploads_dir, "2026-1001", 10)
    response = await download_pdfs_zip(ids=[a.id, a.id, a.id], db=db_session, current_user=OWNER)
    assert _open(response).namelist() == ["2026-1001.pdf"]


async def test_an_unknown_id_fails_the_whole_request_instead_of_returning_a_partial_archive(db_session, uploads_dir):
    a = await _factuur(db_session, uploads_dir, "2026-1001", 10)

    with pytest.raises(HTTPException) as exc:
        await download_pdfs_zip(ids=[a.id, 999_999_999], db=db_session, current_user=OWNER)

    assert exc.value.status_code == 404
    assert exc.value.detail.endswith("[999999999]"), "the detail must name only the id that has no PDF"


async def test_a_row_without_a_stored_pdf_fails_the_request(db_session, uploads_dir):
    bare = await _factuur(db_session, uploads_dir, "2026-1001", 10, pdf=None)
    with pytest.raises(HTTPException) as exc:
        await download_pdfs_zip(ids=[bare.id], db=db_session, current_user=OWNER)
    assert exc.value.status_code == 404


async def test_a_pdf_url_whose_file_is_gone_from_disk_fails_the_request(db_session, uploads_dir):
    a = await _factuur(db_session, uploads_dir, "2026-1001", 10)
    (uploads_dir / f"{a.id}.pdf").unlink()
    with pytest.raises(HTTPException) as exc:
        await download_pdfs_zip(ids=[a.id], db=db_session, current_user=OWNER)
    assert exc.value.status_code == 404


async def test_the_demo_account_is_refused_before_any_file_is_read(db_session, uploads_dir):
    a = await _factuur(db_session, uploads_dir, "2026-1001", 10)
    with pytest.raises(HTTPException) as exc:
        await download_pdfs_zip(ids=[a.id], db=db_session, current_user=DEMO)
    assert exc.value.status_code == 403
