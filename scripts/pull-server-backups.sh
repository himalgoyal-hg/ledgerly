#!/bin/bash
# Copy the server's nightly backups down to this Mac (run weekly, or from cron).
#   scripts/pull-server-backups.sh            → ~/Ledgerly-backups/
set -e
HOST=root@187.127.188.95
KEY=~/.ssh/kinnect_hostinger
DEST=${1:-$HOME/Ledgerly-backups}
mkdir -p "$DEST"
ssh -i $KEY $HOST 'A=$(docker ps -q --filter name=app-cqpuaxfz | head -1) && rm -rf /root/ledgerly-backups && docker cp "$A":/app/backups /root/ledgerly-backups'
rsync -az -e "ssh -i $KEY" $HOST:/root/ledgerly-backups/ "$DEST/"
echo "Backups in $DEST:"; ls -t "$DEST" | grep ndjson.gz | head -3
