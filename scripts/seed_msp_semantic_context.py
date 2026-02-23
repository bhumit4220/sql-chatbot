"""Seed MSP semantic context via the API.

Usage (from host):
    cd "/home/sotsys-322/Ruby Projects/sql-chatbot"
    .venv/bin/python scripts/seed_msp_semantic_context.py

Requires the API to be running at http://localhost:8000.
"""

import json
import sys
from pathlib import Path

import httpx

API_BASE = "http://localhost:8000/api/v1"
PAYLOAD_PATH = Path(__file__).parent / "msp_semantic_context.json"


def main():
    email = input("Admin email [admin@msp.local]: ").strip() or "admin@msp.local"
    password = input("Admin password: ").strip()
    if not password:
        print("Error: password required")
        sys.exit(1)

    project_id_str = input("Project ID [1]: ").strip() or "1"
    project_id = int(project_id_str)

    # Login
    print(f"\nLogging in as {email}...")
    r = httpx.post(f"{API_BASE}/auth/login", json={"email": email, "password": password})
    if r.status_code != 200:
        print(f"Login failed ({r.status_code}): {r.text}")
        sys.exit(1)
    token = r.json()["access_token"]
    print("Login successful.")

    headers = {"Authorization": f"Bearer {token}"}

    # Load payload
    payload = json.loads(PAYLOAD_PATH.read_text())
    print(f"\nLoaded payload from {PAYLOAD_PATH.name}")
    for key, items in payload.items():
        if items:
            print(f"  {key}: {len(items)} items")

    # Import
    print(f"\nPosting to /projects/{project_id}/knowledge/semantic-context ...")
    r = httpx.post(
        f"{API_BASE}/projects/{project_id}/knowledge/semantic-context",
        json=payload,
        headers=headers,
    )
    if r.status_code == 201:
        result = r.json()
        print(f"\nSuccess!")
        print(f"  Created: {result['created_count']}")
        print(f"  Deleted (replaced): {result['deleted_count']}")
        print(f"  Categories: {result['categories']}")
    else:
        print(f"\nFailed ({r.status_code}): {r.text}")
        sys.exit(1)


if __name__ == "__main__":
    main()
