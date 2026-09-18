# Going live on Vercel

Vercel runs the app; two hosted stores hold the data:

- **Neon Postgres** (added from Vercel's Storage tab) — the books.
- **Vercel Blob** (private store) — uploaded bills, receipts and policies.

Migrations run on every deploy. The daily automation runs as a Vercel Cron.
Backups are taken from the Mac against the hosted database.

The Docker/VPS route in `deploy-hostinger.md` still works; the code picks the
storage from the environment, so nothing in the app changes between the two.

## 1. Create the Vercel project

1. vercel.com → **Add New → Project** → Import `himalgoyal-hg/ledgerly`.
2. Framework: Next.js (auto-detected). Leave the build command alone —
   `package.json` has a `vercel-build` script that runs
   `prisma generate && prisma migrate deploy && next build`.
3. Do **not** deploy yet — add the stores and variables first (steps 2–4).
   If it deploys anyway, it fails on the missing DATABASE_URL; that is fine.

## 2. Add Postgres (Neon)

Project → **Storage → Create Database → Neon (Postgres)**.
Region: **Singapore (ap-southeast-1)** — the closest to India. Connect it to
the project for all environments. This sets `DATABASE_URL` (pooled) and
`DATABASE_URL_UNPOOLED` (direct; used for migrations) automatically.

## 3. Add Blob storage

Project → **Storage → Create → Blob**. Connect it to the project. This sets
`BLOB_READ_WRITE_TOKEN`; the app switches to Blob for documents when it sees
that variable. The store is used in **private** mode — files are only ever
served through the app's own `/files/<id>` route, behind login.

## 4. Environment variables

Project → **Settings → Environment Variables** (Production; also Preview if you
want preview deploys to work). Generate each secret with `openssl rand -hex 32`.

| Name                   | Value                                                 |
| ---------------------- | ----------------------------------------------------- |
| `SESSION_SECRET`       | random, 32+ chars — **not** the local dev value       |
| `CRON_SECRET`          | random — Vercel sends it on every cron call           |
| `ANTHROPIC_API_KEY`    | optional — AI tagging / PDF reading                   |
| `SMTP_HOST` … `SMTP_FROM` | optional — reminder and weekly-summary emails      |

Leave `SEED_ADMIN_PASSWORD` / `SEED_MEMBER_PASSWORD` unset: users arrive
with the backup in step 7.

## 5. Deploy

**Deployments → Redeploy** (or push to `main`). The build applies the
migrations to the empty Neon database, so the first load shows the login page
with no users yet — expected until step 7.

Vercel functions run in Singapore (`regions` in `vercel.json`) next to the
database.

## 6. Domain (GoDaddy)

1. Project → **Settings → Domains → Add** `books.yourdomain.com`
   (or the bare domain). Vercel shows the record it needs.
2. GoDaddy → My Products → DNS for the domain → **Add record**:

| Type  | Name    | Value                  | TTL     |
| ----- | ------- | ---------------------- | ------- |
| CNAME | `books` | `cname.vercel-dns.com` | default |

For the bare domain instead: an **A** record, name `@`, value `76.76.21.21`.
Vercel issues the HTTPS certificate itself once the record resolves
(minutes to an hour on GoDaddy).

## 7. Move the books across

On the Mac, make a file `.env.prod` (gitignored) with the production values —
copy them from Vercel → Storage → Neon → `.env.local` tab and Blob → the
token:

```bash
DATABASE_URL=<DATABASE_URL_UNPOOLED from Neon>
BLOB_READ_WRITE_TOKEN=<from the Blob store>
```

Then:

```bash
npm run backup                                      # from the local books
DOTENV_CONFIG_PATH=.env.prod npm run restore -- backups/ledgerly-<stamp>.ndjson.gz
```

The restore loads every table, pushes the documents folder into Blob, and
confirms Dr = Cr in every book. It refuses to overwrite a database that
already has entries unless `--replace` is added.

Users come across with the backup, so everyone logs in with the same email and
password as on the Mac. **Change all four passwords straight away**
(Admin → Users). From this point Vercel is the master copy — stop entering
data on the Mac.

## 8. Daily automation

`vercel.json` schedules `/api/automation/run` at 01:30 UTC (07:00 IST). On the
Hobby plan Vercel fires it some time within that hour; on Pro, at the minute.
Check runs under Project → **Settings → Cron Jobs → View Logs**.

## 9. Backups

Vercel and Neon keep no copy you can restore the books from on your own
terms, so take one weekly from the Mac (or schedule it with `crontab -e`):

```bash
DOTENV_CONFIG_PATH=.env.prod npm run backup
```

That writes `backups/ledgerly-<stamp>.ndjson.gz` plus a `-uploads` folder
pulled from Blob. Prove it restores now and then:

```bash
DOTENV_CONFIG_PATH=.env.prod npm run restore-drill
```

## 10. Shipping an update later

`git push origin main`. Vercel builds, runs new migrations, and switches
traffic over when the build succeeds. A failed build leaves the previous
deployment live.

## Limits to know

- **Uploads over 4.5 MB fail** with a platform error (Vercel's request body
  cap). Bills and receipts are usually well under that; compress a large photo
  before attaching. Statement files (CSV/XLSX/PDF) are also subject to it.
- Functions time out after 300 s. Reading a long PDF statement with AI stays
  within that; if it does not, split the PDF by month.
