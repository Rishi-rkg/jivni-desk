"""Create a local development .env with random secrets without printing them."""
import secrets
from pathlib import Path

root = Path(__file__).resolve().parent.parent
target = root / ".env"
if target.exists():
    raise SystemExit(".env already exists; existing credentials were not changed.")
content = (root / ".env.example").read_text()
content = content.replace("DJANGO_SECRET_KEY=\n", f"DJANGO_SECRET_KEY={secrets.token_urlsafe(64)}\n")
content = content.replace("POSTGRES_PASSWORD=\n", f"POSTGRES_PASSWORD={secrets.token_urlsafe(32)}\n")
with target.open("x", encoding="utf-8", newline="\n") as stream:
    stream.write(content)
print("Created .env for local development. Use synthetic data only.")
