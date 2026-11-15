# Deploying Parlor on cruftmanor.com

Host facts (inventoried 2026-11-14): AlmaLinux 8.10, InterWorx control panel, Apache 2.4 (`httpd`) on ports 80/443 bound to 67.43.2.255, DNS for cruftmanor.com served by ns1/ns2.pusateri.com (InterWorx, same host). System Node is v20 and is used by other things; Parlor brings its own Node. Clockwork (`clockwork-conductor.service`, `clockwork-dashboard.service` on 127.0.0.1:5000, proxied on :8443) is not touched by anything here.

InterWorx regenerates `/etc/httpd/conf.d/vhost_*.conf`, so Parlor uses its own file, `/etc/httpd/conf.d/zzz-parlor.conf`, and its own certificate from acme.sh. Do not add parlor.cruftmanor.com to the InterWorx cruftmanor.com certificate: Parlor's port-80 virtual host would answer that certificate's renewal challenge and break its renewal.

## Layout

| Path | Owner | Purpose |
|---|---|---|
| `/opt/parlor/node` | root | Node 24 (private copy) |
| `/opt/parlor/app` | root, read-only to the service | Parlor code and `node_modules` |
| `/opt/parlor/acme.sh` | root | acme.sh (certificate client) |
| `/etc/parlor/parlor.env` | root:parlor 0640 | Configuration, including `SESSION_KEY` |
| `/etc/parlor/tls/` | root:parlor 0750 | Certificate and key for Apache |
| `/etc/parlor/acme/` | root | acme.sh account and state |
| `/var/lib/parlor/` | parlor 0700 | SQLite database (OAuth sessions encrypted with `SESSION_KEY`) |
| `/var/www/parlor-acme/` | root | ACME HTTP-01 webroot |
| `/etc/systemd/system/parlor.service` | root | Service unit (copy of `deploy/parlor.service`) |

The service runs as the `parlor` system user (no shell, no home login), listens on 127.0.0.1:8790, can write only `/var/lib/parlor`, and is limited to 300 MB of memory and half a CPU.

## DNS (done by the domain owner)

In InterWorx DNS for cruftmanor.com:

1. `A` record: `parlor.cruftmanor.com` → `67.43.2.255`
2. `TXT` record: `_lexicon.parlor.cruftmanor.com` → `did=did:plc:e2fj77s3rygus52me3ul6qka`

Do not create an InterWorx "subdomain" for parlor; only the DNS records are needed.

The TXT record makes the space type declaration `com.cruftmanor.parlor.space` resolvable. It is published as a `com.atproto.lexicon.schema` record in the clockworkconductor sandbox account (that DID). Without it, OAuth sign-in fails with "Unable to retrieve space declarations". A failed lookup is cached by the sandbox for about 5 minutes.

Check both before continuing:

    dig +short A parlor.cruftmanor.com @ns1.pusateri.com
    dig +short TXT _lexicon.parlor.cruftmanor.com @ns1.pusateri.com

## Certificate and Apache (after DNS)

    # 1. Port-80 vhost only, so the ACME challenge can be answered
    sed -n '1,/^<\/VirtualHost>/p' /opt/parlor/app/deploy/apache-parlor.conf > /etc/httpd/conf.d/zzz-parlor.conf
    apachectl configtest && systemctl reload httpd

    # 2. Issue the certificate
    /opt/parlor/acme.sh/acme.sh --home /opt/parlor/acme.sh --config-home /etc/parlor/acme \
      --server letsencrypt --issue -d parlor.cruftmanor.com -w /var/www/parlor-acme
    /opt/parlor/acme.sh/acme.sh --home /opt/parlor/acme.sh --config-home /etc/parlor/acme \
      --install-cert -d parlor.cruftmanor.com \
      --fullchain-file /etc/parlor/tls/fullchain.pem --key-file /etc/parlor/tls/privkey.pem \
      --reloadcmd "systemctl reload httpd"

    # 3. Full vhost (80 + 443)
    cp /opt/parlor/app/deploy/apache-parlor.conf /etc/httpd/conf.d/zzz-parlor.conf
    apachectl configtest && systemctl reload httpd

    # 4. Renewal (daily check; acme.sh renews ~30 days before expiry)
    echo '17 3 * * * root /opt/parlor/acme.sh/acme.sh --cron --home /opt/parlor/acme.sh --config-home /etc/parlor/acme > /dev/null' > /etc/cron.d/parlor-acme

Apache reads the key as root before dropping privileges, so `/etc/parlor/tls` needs no access for the `apache` user.

## Updating the code

From a checkout of this repository, after committing:

    git archive HEAD \
      | ssh clockwork-prod 'tar -x -C /opt/parlor/app --no-same-owner \
          && cd /opt/parlor/app && PATH=/opt/parlor/node/bin:$PATH npm ci --omit=dev \
          && chown -R root:root /opt/parlor/app && systemctl restart parlor'

`git archive HEAD` sends exactly the committed tree: no uncommitted edits, untracked files, `.env`, `data/` or `node_modules`. It does not delete files on the server that were removed from the repository; remove those by hand.

Restarting keeps sign-ins (sessions are in SQLite); open chat views re-sync.

## Operating

    systemctl status parlor
    journalctl -u parlor -n 100
    curl -s http://127.0.0.1:8790/healthz

Logs record sign-ins, space creation and membership changes by DID and space URI. They never contain tokens, message text or passwords.

To stop everyone's access at once: `systemctl stop parlor`. To revoke all stored sessions: stop the service and delete `/var/lib/parlor/parlor.db*` (users sign in again; the directory of spaces is lost, the spaces themselves are not).

## Removing Parlor

    systemctl disable --now parlor
    rm -f /etc/systemd/system/parlor.service /etc/httpd/conf.d/zzz-parlor.conf /etc/cron.d/parlor-acme
    systemctl daemon-reload && systemctl reload httpd
    rm -rf /opt/parlor /etc/parlor /var/lib/parlor /var/www/parlor-acme
    userdel parlor
