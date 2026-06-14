# agent-relay — Azure lib

The **only** Azure-aware code in agent-relay. Everything that depends on Azure — the `@azure/identity` credential adapter and
the Microsoft Entra token scope — lives in **this folder**. Its **companion
provisioning script** is `scripts/provision-azure.ps1` (a sibling, kept as a
shell script because it runs `az`); it is part of the Azure surface and is taken
along on extraction (see *How to extract later*). Everything is deliberately
isolated so it can be **lifted out into a separate repo or npm package** later
(e.g. `@agent-relay/azure`) with no change to the rest of the extension.

## What's here

| File | Role |
|---|---|
| `credentials.mjs` | `createAzureEntraCredentials()` → a `CredentialProvider` whose `get()` mints a PostgreSQL-scoped Microsoft Entra access token. |
| `index.mjs` | The stable public surface (re-exports). Import the lib only through this. |

The companion provisioning script lives at `scripts/provision-azure.ps1` (it runs
`az`, so it stays a shell script rather than JS).

## How it plugs in (no lock-in)

agent-relay's core never knows Azure exists. The cross-machine **Postgres
transport is vendor-neutral** (`pg` only) and obtains its connection password
through the **Credentials seam** (`extension/seams/credentials.mjs`). The
composition root (`extension/config.mjs`) is the single place that picks this
Azure credential for the Postgres profile:

```js
import { createAzureEntraCredentials } from "./azure/index.mjs";
// …in the postgres branch:
credentials: createAzureEntraCredentials(),
```

`pg` accepts an async function for its `password`, so the transport calls
`credentials.get()` per new connection and always authenticates with a fresh
token. Password auth on the server is disabled; the token + TLS is the security
boundary.

## How to extract later

1. Move this `azure/` folder to its own package; keep `index.mjs` as the entry.
2. Move `scripts/provision-azure.ps1` alongside it.
3. In agent-relay, replace `import … from "./azure/index.mjs"` with the package
   name. Nothing else references Azure — the transport and core are untouched.

Because every `@azure/*` import is confined to this folder and the rest of the
code depends only on the Credentials seam, extraction is a folder move plus one
import swap.

## Auth model

- **Microsoft Entra token, password auth disabled, TLS required.** No password
  exists to leak; only a valid Entra token for a server admin can connect.
- **No IP allowlist is relied upon** — the security boundary is authentication,
  not network location (egress IPs can rotate). Public network access stays on,
  gated by Entra.
- The token is minted **locally on each machine** via the user's `az login` /
  environment (`DefaultAzureCredential`). Tokens are never stored or transferred.
