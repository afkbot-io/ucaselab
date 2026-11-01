#!/usr/bin/env bash
# Back up one Compose project, then resume only services that were running before the pause.
set -euo pipefail
cd "${UCASELAB_COMPOSE_DIR:-$(dirname "$0")/..}"
umask 077
backup_root="${1:-./data/backups}"
mkdir -p "$backup_root"
backup_dir="$backup_root/ucaselab-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$backup_dir"
running_output="$(docker compose ps --status running --services)"
running_services=()
while IFS= read -r service; do
    case "$service" in web|api|worker) running_services+=("$service");; esac
done <<< "$running_output"
resume_services() {
    if ((${#running_services[@]})); then
        docker compose start "${running_services[@]}" >/dev/null
    fi
}
# Install the trap before stopping: even a partial stop must be recoverable.
trap resume_services EXIT
if ((${#running_services[@]})); then
    docker compose stop "${running_services[@]}"
fi
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$backup_dir/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar api -C /data -czf - attachments > "$backup_dir/attachments.tar.gz"
cp .env "$backup_dir/environment.env"
cp uv.lock "$backup_dir/uv.lock"
python3 - "$backup_dir" <<'PY'
import hashlib,json,sys
from pathlib import Path
folder=Path(sys.argv[1])
manifest={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.iterdir() if p.is_file()}
(folder/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
PY
printf 'Backup created: %s\n' "$backup_dir"
printf 'Keep environment.env private: it contains the encryption key needed for account passwords.\n'
