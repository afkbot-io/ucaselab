#!/usr/bin/env python3
"""Generate unique local/deployment credentials without printing them."""
import base64
import secrets
from pathlib import Path
path = Path(__file__).resolve().parents[1] / '.env'
if path.exists():
    raise SystemExit('.env already exists; preserved without changes')
password = secrets.token_hex(24)
path.write_text('''# For production set HTTPS PUBLIC_URL, COOKIE_SECURE=true and real SMTP.
COMPOSE_PROJECT_NAME=ucaselab
POSTGRES_USER=ucaselab
POSTGRES_DB=ucaselab
ENVIRONMENT=development
PUBLIC_URL=http://localhost:5173
COOKIE_SECURE=false
HTTP_PORT=127.0.0.1:8080
POSTGRES_PASSWORD=%s
DATABASE_URL=postgresql+psycopg://ucaselab:%s@localhost:54329/ucaselab
SECRET_KEY=%s
ENCRYPTION_KEY=%s
SMTP_HOST=localhost
SMTP_PORT=10259
SMTP_FROM=UCaseLab <noreply@localhost>
ALLOWED_HOSTS=localhost,127.0.0.1,testserver,api
''' % (password, password, secrets.token_urlsafe(48), base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()))
path.chmod(0o600)
print('Created .env with unique credentials (mode 0600)')
