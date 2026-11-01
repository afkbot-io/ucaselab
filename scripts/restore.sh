#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# != 2 || "$2" != '--replace-database' ]]; then
    printf 'Usage: bash scripts/restore.sh /absolute/backup/folder --replace-database\n'
    printf 'This replaces the current database and attachments. Restore the matching environment.env to .env first.\n'
    exit 2
fi
backup_dir="$1"
test -f "$backup_dir/database.dump"
test -f "$backup_dir/attachments.tar.gz"
python3 - "$backup_dir" <<'VERIFY'
import hashlib,json,sys
from pathlib import Path
folder=Path(sys.argv[1])
for name,expected in json.loads((folder/'manifest.json').read_text()).items():
    path=folder/name
    if path.parent!=folder or hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
        raise SystemExit('Backup checksum mismatch')
VERIFY
docker compose stop web api worker
docker compose up -d --wait db
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"' 
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" "$POSTGRES_DB"' 
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error'  < "$backup_dir/database.dump"
docker compose run --rm --no-deps -T --entrypoint sh api -c 'find /data/attachments -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar -C /data -xzf -' < "$backup_dir/attachments.tar.gz"
docker compose run --rm migrate
docker compose up -d --wait
printf 'Restore completed. Verify /api/health/ready and an encrypted test account.\n'
