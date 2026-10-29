# One-time deployment setup

This is an optional single-host deployment adapter. The product also runs with
ordinary Docker Compose and any HTTPS reverse proxy. This SSH adapter uses a
dedicated deployment user's **rootless Docker** daemon. Neither this user nor
the application/agent account needs sudo or access to a root Docker daemon.

## Host contract

Install Docker Engine, rootless prerequisites and the Compose plugin using your
OS's supported method. Follow Docker's rootless setup for a dedicated SSH
deployment user, including subordinate UID/GID ranges and user-service linger.
Its socket must be `/run/user/<uid>/docker.sock`. Create an administrator-owned
deployment directory and a release-state directory owned by the deployment user.
Use cgroup v2 with the systemd driver and delegate `cpu memory pids` to this
user's systemd manager. Check the effective controllers and the running
container's limits; merely declaring limits in Compose is insufficient when the
host has not delegated them. See [Docker's rootless resource-limit guidance](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources).
Install reviewed copies of:

- `compose.yaml` into your deployment directory;
- `deploy/release.py` at `/usr/local/libexec/zhongshu-release` (root:root 0755);
- `deploy/ssh-entrypoint.sh` at `/usr/local/libexec/zhongshu-ssh` (root:root 0755).

Write `/etc/zhongshu-deploy/config.json` as root:deployment-group 0640, in a 0750
directory owned by the same identity. Replace the example values:

```json
{
  "image_repository": "ghcr.io/your-account/your-repository",
  "compose_file": "/srv/your-instance/deploy/compose.yaml",
  "state_directory": "/srv/your-instance/releases",
  "project_name": "your-instance",
  "port": 8787
}
```

Every parent of the executable, configuration and Compose file must be
administrator-owned and not writable by the SSH or app accounts. Only release
state and the rootless runtime's private directories are deployment-user writable.
The helper reads only this host configuration; it never downloads a
Compose file or script from a deployment request.

Generate a dedicated SSH key. Store its public entry in an administrator-owned
file such as `/etc/ssh/authorized_keys/your-deploy-account`. The entry must start:

```text
restrict,command="/usr/local/libexec/zhongshu-ssh" ssh-ed25519 REPLACE_WITH_PUBLIC_KEY
```

The deployment user owns its HOME for rootless Docker. Keep SSH authorization
outside that HOME so it cannot replace the forced-command restriction. Add a
host-specific sshd configuration for **only this user**, for example:

```text
Match User your-deploy-account
    AuthorizedKeysFile /etc/ssh/authorized_keys/your-deploy-account
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding no
    PermitTTY no
    X11Forwarding no
    ForceCommand /usr/local/libexec/zhongshu-ssh
Match all
```

Validate with `sshd -t` before reloading SSH. The key file and its directory may
be root-owned 0644/0755 (public key material only). Use a normal shell for
forced-command execution and lock the account password. Do not grant sudo or
add it to the Docker group. The helper accepts one command:
`deploy ghcr.io/owner/repository@sha256:<digest> <full-commit>`. It checks the
host's repository allowlist and image revision before activating a fixed Compose
project. Other commands, SSH forwarding and PTYs are disabled. The key still
authorizes replacing this application with an image from the allowed repository,
so protect repository write access and the production environment accordingly.

The optional JSON on stdin carries a short-lived registry credential. The helper
uses it only to pull the image, in a private user-runtime Docker configuration which is
removed on exit. No permanent registry token is required. Send `{}` for a public
image. GHCR package visibility is separate from source-repository visibility;
set the package public if you want anonymous image pulls.

## GitHub configuration

Create a `production` Environment and restrict deployments to `main`.

Environment variables:

| Name | Value |
|---|---|
| `DEPLOY_HOST` | SSH host/IP, without a URL scheme |
| `DEPLOY_PORT` | SSH port, commonly 22 |
| `DEPLOY_USER` | Dedicated deployment account |
| `PUBLIC_URL` | HTTPS origin of this deployment |

Environment secrets:

| Name | Value |
|---|---|
| `DEPLOY_SSH_KEY` | Dedicated private key, never your administrator key |
| `DEPLOY_KNOWN_HOSTS` | Host key verified through a trusted administrator connection |

Set the **repository** variable `DEPLOY_ENABLED=true` when the host is ready.
Actions uses its built-in `GITHUB_TOKEN` for GHCR publication and an ephemeral
package-read token during deployment. No Cloudflare credentials belong in this
workflow. Expose the loopback app port through your separately configured HTTPS
entrypoint.

## Operations

The release-state directory records `current.json` and `previous.json`, including
image digests, Git revisions and deployment times. To roll back, run the GitHub
`Deploy an existing image` workflow with the desired digest and revision.

Updating app code normally requires only a push/merge to `main`. Updating the
host's release helper or Compose definition requires an administrator to install
the reviewed new version separately; a CI deployment cannot rewrite its own
administrator-installed entrypoint. The simple Compose replacement may briefly interrupt the
page; zero-downtime deployment is outside this initial tracer.

Old images are retained for rollback. Establish a retention policy as releases
accumulate; there is no global `docker system prune` in the deployment script.
