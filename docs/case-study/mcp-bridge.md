# Case Study: Securing Internet Search for the Self-Hosted LLM (`mcp-bridge`)

## Context

At the time of this work, the cluster ran Qwen3.5-2B via `llama-server`
(a StatefulSet in `labs/llm/llama-server.yaml`) behind Envoy Gateway and Dex.
The serving model may have changed since; consult `labs/llm/` and the live
cluster for the current deployment. llama.cpp's web UI supports MCP (Model
Context Protocol) tool servers, letting the model call a search tool during a
conversation instead of relying only on training data.

The goal: let Qwen3.5-2B search the internet (via Tavily's Search API) from
the browser-based web UI, without compromising the cluster or leaking
secrets.

## Attempt 1: llama.cpp's built-in `--webui-mcp-proxy`

llama-server ships an experimental flag, `--webui-mcp-proxy`, that lets the
browser tell the server "fetch this MCP URL for me," working around
browser CORS restrictions.

```
Browser (web UI)                llama-server pod              Tavily MCP
      |                               |                             |
      |--- POST /mcp-proxy ---------->|                             |
      |    { url: <any-url> }         |                             |
      |                               |--- fetch(url) ------------->|
      |                               |<---- response ---------------|
      |<---- response -----------------|                             |
```

The problem: the proxy accepted **any** URL from the browser, not just
Tavily's. That's a classic **SSRF (Server-Side Request Forgery)** — the
attacker (or just a malicious script running in the user's browser tab)
controls what the *server* fetches, and the server has network access the
browser normally wouldn't (cluster-internal DNS, no CORS, no browser
sandboxing).

### Demonstrating it (with explicit authorization, on our own infra)

From the browser console, instead of pointing the proxy at Tavily, it was
pointed at internal-only Kubernetes services:

```
Attacker-controlled fetch()              llama-server pod (SSRF relay)         Internal cluster services
        |                                          |                                    |
        |-- proxy fetch: kubernetes.default.svc -->|                                    |
        |                                          |--- GET /version ----------------->|  (K8s API)
        |                                          |<---- 200 OK ------------------------|
        |<----------------- relayed response -------|                                    |
        |                                          |                                    |
        |-- proxy fetch: prometheus.monitoring... ->|                                    |
        |                                          |--- GET /config ------------------->|  (Prometheus)
        |                                          |<---- full YAML config --------------|
        |<----------------- relayed response -------|                                    |
```

Confirmed reachable through the relay: the Kubernetes API server version
endpoint, and a full Prometheus config dump (Grafana/Longhorn attempts
failed, but the pattern was proven). None of this should ever be reachable
from a browser tab — the SSRF let the browser use the *pod's* network
identity as a stepping stone into the cluster's internal-only services.

Root cause, confirmed against upstream issues (`ggml-org/llama.cpp#20372`,
`#10854`, `#21012`): `--webui-mcp-proxy` is an open relay by design in its
current state, and a related bug means it also breaks when placed behind
an authenticating reverse proxy (our OIDC setup) — custom headers get
mishandled during the browser's CORS preflight. There was no safe
configuration of this flag; `--cors-origins` (which was first suspected as
the missing guard) doesn't apply here — the "restrict to localhost"
behavior belongs to an unrelated flag (`-ag`/`--agent`).

**Fix: remove `--webui-mcp-proxy` entirely.** Verified closed via a live
browser retest returning `403 feature_disabled`.

## Attempt 2: a purpose-built bridge (`mcp-bridge`)

Since the generic relay was unfixable, the replacement is a small
Node.js service with **no general-purpose fetch capability at all** — it
only ever proxies to one hardcoded destination: `https://mcp.tavily.com/mcp`.

```
Browser (web UI)          mcp-bridge pod (lab ns)              Tavily MCP API
      |                          |                                    |
      |-- POST /mcp?token=... -->|                                    |
      |   (search query)         |-- validate BRIDGE_TOKEN            |
      |                          |-- attach TAVILY_API_KEY (server-side)
      |                          |-- force DEFAULT_PARAMETERS header  |
      |                          |                                    |
      |                          |--- POST mcp.tavily.com/mcp ------->|
      |                          |<---- search results -----------------|
      |<-- proxied response ------|                                    |
```

Key design properties, and the specific issue each one closes:

| Problem being solved | How the bridge closes it |
|---|---|
| SSRF (arbitrary destination) | Destination URL is a hardcoded constant in the code — there is no `url` parameter a client can influence. Structurally cannot be redirected anywhere else. |
| API key exposure | `TAVILY_API_KEY` lives only in the pod's environment (from OCI Vault via `ExternalSecret`), attached to the upstream request server-side. The browser never sees it. |
| CORS/OIDC preflight breakage | Bridge auth uses a token as a **query param** (`?token=...`) rather than a custom header, avoiding the preflight/OIDC interaction that broke the original approach. The bridge itself sits outside OIDC (`HTTPRoute` with no `SecurityPolicy`), gated only by this token. |
| Context-window overflow | Tavily was returning full raw webpage content when the model requested it, blowing past the model's context size (seen failing at both 4096 and later 8192 tokens). The bridge injects a `DEFAULT_PARAMETERS` header forcing `max_results: 3`, `search_depth: basic`, `include_raw_content: false`, `include_images: false` — overriding whatever the model's tool call asked for. |

### The `DEFAULT_PARAMETERS` bug (found during rollout)

The first version of the bridge set the "forced defaults" as **query
params** on the upstream request. Tavily silently ignores query params for
this and only honors a `DEFAULT_PARAMETERS` HTTP header. Result: the model
could still request `include_raw_content: true` and get it, defeating the
control. Confirmed via direct curl test (client asked for `max_results:10`,
got 3 once fixed; asked for `include_raw_content:true`, got `null`).

### Secret handling

Both the Tavily API key and the bridge's own access token follow the
cluster's existing pattern (`oracle-vault` `ClusterSecretStore` +
`ExternalSecret`), matching how every other secret in the repo is handled
— no `kubectl create secret` with inline plaintext. This was caught and
corrected before commit: an early draft of `deploy.yaml` had the bridge
token as a plaintext `Secret`/`stringData` block, which was converted to
an `ExternalSecret` before anything was pushed.

## Outcome

- SSRF vector closed (`--webui-mcp-proxy` removed, verified via browser
  test).
- Search works through `mcp-bridge`, with the Tavily key never touching
  the browser.
- Context-overflow crashes from raw search content eliminated.
- Both `llama-server` and `mcp-bridge` resource limits were subsequently
  right-sized against real (not idle) load:
  - `llama-server`: fixed a `--parallel auto` bug that silently spun up 4
    inference slots, each reserving a full context window (4x intended
    memory) — pinned to `--parallel 1`; memory limit settled at 2048Mi
    after an over-aggressive first attempt at 1536Mi caused a real OOMKill
    under actual prompt load.
  - `mcp-bridge`: tightened to `requests: 10m CPU / 24Mi memory`,
    `limits: 100m CPU / 64Mi memory`, verified stable (0 restarts, ~2m
    CPU / 10Mi memory in use) after 5 back-to-back real searches.

## Lessons

1. A generic "let the browser tell the server what to fetch" proxy is
   SSRF by construction — there is no safe flag to tame it once the
   destination is client-controlled. The only real fix was replacing it
   with a bridge that has a fixed destination.
2. Vendor-specific override mechanisms (Tavily's `DEFAULT_PARAMETERS`
   header) aren't always what they look like — query params were a
   plausible but wrong guess; the fix required checking Tavily's actual
   API contract.
3. Resource limits should be set from measurements taken **under real
   load**, not right after a cold start or idle state — the `llama-server`
   OOMKill happened because the first "tight" limit was chosen from an
   idle-slot reading.
