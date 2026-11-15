# Deploying Waystation

Written for a Linux server that runs Apache 2.4 (`httpd`) as the front end alongside other services. Waystation brings its own Node and touches nothing else on the host. Facts about the actual server (OS, control panel, other services, SSH host) are in `DEPLOY.local.md`, which is not committed.

Waystation uses its own Apache file, `/etc/httpd/conf.d/zzz-waystation.conf`, and its own certificate from acme.sh, so a control panel that regenerates its own virtual host files does not overwrite them. Keep waystation.cruftmanor.com off any other certificate on the host: Waystation's port-80 virtual host would answer that certificate's renewal challenge and break its renewal.

## Layout

| Path | Owner | Purpose |
|---|---|---|
| `/opt/waystation/node` | root | Node 24 (private copy) |
| `/opt/waystation/app` | root, read-only to the service | Waystation code and `node_modules` |
| `/opt/waystation/acme.sh` | root | acme.sh (certificate client) |
| `/etc/waystation/waystation.env` | root:waystation 0640 | Configuration, including `SESSION_KEY` |
| `/etc/waystation/tls/` | root:waystation 0750 | Certificate and key for Apache |
| `/etc/waystation/acme/` | root | acme.sh account and state |
| `/var/lib/waystation/` | waystation 0700 | SQLite database (OAuth sessions encrypted with `SESSION_KEY`) |
| `/var/www/waystation-acme/` | root | ACME HTTP-01 webroot |
| `/etc/systemd/system/waystation.service` | root | Service unit (copy of `deploy/waystation.service`) |

The service runs as the `waystation` system user (no shell, no home login), listens on 127.0.0.1:8791 (set with `PORT=8791` in `waystation.env`), can write only `/var/lib/waystation`, and is limited to 300 MB of memory and half a CPU.

## DNS (done by the domain owner)

In the DNS for cruftmanor.com:

1. `A` record: `waystation.cruftmanor.com` → the server's address
2. `TXT` record: `_lexicon.waystation.cruftmanor.com` → `did=did:plc:e2fj77s3rygus52me3ul6qka`

Only these two records are needed.

The TXT record makes the space type declaration `com.cruftmanor.waystation.space` resolvable. It is published as a `com.atproto.lexicon.schema` record in the clockworkconductor sandbox account (that DID). Without it, OAuth sign-in fails with "Unable to retrieve space declarations". A failed lookup is cached by the sandbox for about 5 minutes.

Check both before continuing:

    dig +short A waystation.cruftmanor.com
    dig +short TXT _lexicon.waystation.cruftmanor.com

## Certificate and Apache (after DNS)

    # 1. Port-80 vhost only, so the ACME challenge can be answered
    sed -n '1,/^<\/VirtualHost>/p' /opt/waystation/app/deploy/apache-waystation.conf > /etc/httpd/conf.d/zzz-waystation.conf
    apachectl configtest && systemctl reload httpd

    # 2. Issue the certificate
    /opt/waystation/acme.sh/acme.sh --home /opt/waystation/acme.sh --config-home /etc/waystation/acme \
      --server letsencrypt --issue -d waystation.cruftmanor.com -w /var/www/waystation-acme
    /opt/waystation/acme.sh/acme.sh --home /opt/waystation/acme.sh --config-home /etc/waystation/acme \
      --install-cert -d waystation.cruftmanor.com \
      --fullchain-file /etc/waystation/tls/fullchain.pem --key-file /etc/waystation/tls/privkey.pem \
      --reloadcmd "systemctl reload httpd"

    # 3. Full vhost (80 + 443)
    cp /opt/waystation/app/deploy/apache-waystation.conf /etc/httpd/conf.d/zzz-waystation.conf
    apachectl configtest && systemctl reload httpd

    # 4. Renewal (daily check; acme.sh renews ~30 days before expiry)
    echo '17 3 * * * root /opt/waystation/acme.sh/acme.sh --cron --home /opt/waystation/acme.sh --config-home /etc/waystation/acme > /dev/null' > /etc/cron.d/waystation-acme

Apache reads the key as root before dropping privileges, so `/etc/waystation/tls` needs no access for the `apache` user.

## Updating the code

From a checkout of this repository, after committing:

    git archive HEAD \
      | ssh <ssh-host> 'tar -x -C /opt/waystation/app --no-same-owner \
          && cd /opt/waystation/app && PATH=/opt/waystation/node/bin:$PATH npm ci --omit=dev \
          && chown -R root:root /opt/waystation/app && systemctl restart waystation'

`git archive HEAD` sends exactly the committed tree: no uncommitted edits, untracked files, `.env`, `data/` or `node_modules`. It does not delete files on the server that were removed from the repository; remove those by hand.

Restarting keeps sign-ins (sessions are in SQLite); open chat views re-sync.

## Operating

    systemctl status waystation
    journalctl -u waystation -n 100
    curl -s http://127.0.0.1:8791/healthz

Logs record sign-ins, space creation and membership changes by DID and space URI. They never contain tokens, message text or passwords.

To stop everyone's access at once: `systemctl stop waystation`. To revoke all stored sessions: stop the service and delete `/var/lib/waystation/waystation.db*` (users sign in again; the directory of spaces is lost, the spaces themselves are not).

## Removing Waystation

    systemctl disable --now waystation
    rm -f /etc/systemd/system/waystation.service /etc/httpd/conf.d/zzz-waystation.conf /etc/cron.d/waystation-acme
    systemctl daemon-reload && systemctl reload httpd
    rm -rf /opt/waystation /etc/waystation /var/lib/waystation /var/www/waystation-acme
    userdel waystation
