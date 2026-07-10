#!/usr/bin/env python3
"""Download all DeepDiveStocks "Weekly Chat" PDF attachments from Gmail via IMAP.

Requires a Gmail app password (https://myaccount.google.com/apppasswords):
    export GMAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx'
    python3 fetch-weekly-chats.py

PDFs land in ./pdfs/ named by the email's send date (weekly-chat-YYYY-MM-DD.pdf),
falling back to the attachment filename on collision. Re-runs skip existing files.
"""

import email
import imaplib
import os
import re
import sys
from email.header import decode_header
from email.utils import parsedate_to_datetime
from pathlib import Path

ACCOUNT = "drewlharmon@gmail.com"
SENDER = "justin@deepdivestocks.com"
OUT_DIR = Path(__file__).parent / "pdfs"


def decode_str(value):
    if value is None:
        return ""
    parts = decode_header(value)
    out = ""
    for text, charset in parts:
        if isinstance(text, bytes):
            out += text.decode(charset or "utf-8", errors="replace")
        else:
            out += text
    return out


def main():
    password = os.environ.get("GMAIL_APP_PASSWORD")
    if not password:
        sys.exit("Set GMAIL_APP_PASSWORD (Gmail app password) first.")

    OUT_DIR.mkdir(exist_ok=True)

    imap = imaplib.IMAP4_SSL("imap.gmail.com")
    imap.login(ACCOUNT, password.replace(" ", ""))
    # [Gmail]/All Mail catches archived messages too
    imap.select('"[Gmail]/All Mail"', readonly=True)

    status, data = imap.search(None, f'(FROM "{SENDER}")')
    if status != "OK":
        sys.exit(f"IMAP search failed: {status}")
    ids = data[0].split()
    print(f"{len(ids)} messages from {SENDER}")

    saved = skipped = no_pdf = 0
    for msg_id in ids:
        status, msg_data = imap.fetch(msg_id, "(RFC822)")
        if status != "OK":
            print(f"  fetch failed for id {msg_id}, skipping")
            continue
        msg = email.message_from_bytes(msg_data[0][1])
        subject = decode_str(msg.get("Subject"))
        if "weekly chat" not in subject.lower():
            continue
        try:
            date = parsedate_to_datetime(msg.get("Date")).strftime("%Y-%m-%d")
        except Exception:
            date = "unknown-date"

        pdf_index = 0
        for part in msg.walk():
            filename = decode_str(part.get_filename())
            if not filename.lower().endswith(".pdf"):
                continue
            if pdf_index == 0:
                target = OUT_DIR / f"weekly-chat-{date}.pdf"
            else:
                # second PDF in the same email (e.g. patch notes) — keep original name
                alt = re.sub(r"[^\w.\- ]", "_", filename)
                target = OUT_DIR / f"{date}-{alt}"
            pdf_index += 1
            if target.exists():
                skipped += 1
                continue
            payload = part.get_payload(decode=True)
            if not payload:
                print(f"  empty payload: {subject}")
                continue
            target.write_bytes(payload)
            saved += 1
            print(f"  saved {target.name}  ({subject})")
        if pdf_index == 0:
            no_pdf += 1
            print(f"  no PDF attachment: {subject} ({date})")

    imap.logout()
    print(f"\nDone: {saved} saved, {skipped} already present, {no_pdf} weekly-chat emails without a PDF")


if __name__ == "__main__":
    main()
