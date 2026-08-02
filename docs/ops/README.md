# Operations

| Document                                         | Contents                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| [`install.sh`](./install.sh)                     | Prepare a host: data root, workspace, secrets file, ownership, modes |
| [`nginx-deployhub.conf`](./nginx-deployhub.conf) | nginx site for the dashboard. Additive; no default_server            |
| [`host-spike.md`](./host-spike.md)               | The external commands the adapters run, verified against a real host |

`install.sh` is the first thing to run on a new server and the first thing to re-run when
something is wrong with the data root. It is idempotent and has a `--dry-run`.

Everything else about running DeployHub in production is in [`../docker.md`](../docker.md).
