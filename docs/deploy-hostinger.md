# Going live on a Hostinger VPS

One VPS runs everything with Docker Compose: the app, Postgres 17, and Caddy
(which gets and renews the HTTPS certificate on its own).

Shared / web hosting plans will **not** work — Ledgerly needs a long-running
Node server, Postgres, and a disk that keeps uploaded documents.

## 1. Buy and prepare the VPS (hPanel)

1. **VPS → KVM 2** (2 vCPU / 8 GB) is comfortable; KVM 1 (4 GB) also works.
   Pick the **India (Mumbai)** data centre.
2. Operating system: **Application → "Ubuntu 24.04 with Docker"**.
3. Set a strong root password, or better, add your Mac's SSH key
   (`cat ~/.ssh/id_ed25519.pub`; create one with `ssh-keygen -t ed25519` if missing).
4. **VPS → Security → Firewall**: allow only ports **22, 80, 443**.
5. Note the server's IP address.

## 2. Point a domain at it

In the DNS zone of your domain (hPanel → Domains → DNS), add:

| Type | Name    | Points to     |
| ---- | ------- | ------------- |
| A    | `books` | the VPS IP    |

That gives `books.yourdomain.com`. Wait until `ping books.yourdomain.com`
shows the VPS IP before step 4 — Caddy needs it to issue the certificate.

## 3. Copy the code to the server

From the Mac, in the project folder:

```bash
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git \
  --exclude '.env*' --exclude backups --exclude uploads \
  ./ root@<VPS-IP>:/opt/ledgerly/
```

The same command is how every later update is shipped.

## 4. Configure and start

```bash
ssh root@<VPS-IP>
cd /opt/ledgerly
cp env.production.example .env
nano .env        # DOMAIN + three secrets; each secret from: openssl rand -hex 32
chmod 600 .env
docker compose up -d --build      # first build takes a few minutes
docker compose logs -f app        # wait for "Ready", then Ctrl+C
```

Migrations run automatically every time the app container starts.
`https://books.yourdomain.com` should now show the login page (empty database).

## 5. Move the books across

On the Mac:

```bash
npm run backup
# copy the newest dump and its documents folder
scp    backups/ledgerly-<stamp>.ndjson.gz root@<VPS-IP>:/opt/ledgerly/backups/
scp -r backups/ledgerly-<stamp>-uploads   root@<VPS-IP>:/opt/ledgerly/backups/
```

On the server:

```bash
cd /opt/ledgerly
docker compose exec app npm run restore -- backups/ledgerly-<stamp>.ndjson.gz
```

It prints the row counts, copies the documents into `uploads/`, and confirms
Dr = Cr in every book. It refuses to overwrite a database that already has
entries unless `--replace` is added.

Users come across with the backup, so everyone logs in with the same email and
password as on the Mac. **Change all four passwords straight away**
(Admin → Users) — they are still the seed defaults.

From this point the server is the master copy. Stop entering data on the Mac.

## 6. Daily jobs

`crontab -e` on the server (times are UTC; 01:30 UTC = 07:00 IST):

```cron
# recurring bills/tasks, reminders, weekly summary
30 1 * * *  cd /opt/ledgerly && docker compose exec -T app node -e "fetch('http://localhost:3000/api/automation/run',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}}).then(r=>process.exit(r.ok?0:1))"
# nightly backup (database + documents), keep 30 days
30 18 * * * cd /opt/ledgerly && docker compose exec -T app npm run backup >/dev/null && find backups -maxdepth 1 -mtime +30 -exec rm -rf {} +
```

A backup that lives only on the same server is not a backup. Once a week, pull
them down to the Mac (or schedule this with `crontab -e` on the Mac):

```bash
rsync -az root@<VPS-IP>:/opt/ledgerly/backups/ ~/Ledgerly-backups/
```

Also switch on Hostinger's weekly VPS snapshots (hPanel → VPS → Snapshots & Backups).

## 7. Shipping an update later

```bash
# Mac — same rsync as step 3, then:
ssh root@<VPS-IP> 'cd /opt/ledgerly && docker compose up -d --build'
```

Data is untouched by a rebuild: Postgres lives in the `pgdata` volume, documents
in `/opt/ledgerly/uploads`, backups in `/opt/ledgerly/backups`.

## Handy commands

```bash
docker compose ps                 # is everything up?
docker compose logs --tail 100 app
docker compose restart app
docker compose exec app npm run restore-drill   # prove the newest backup restores
```
