# Security Audit — OCI Homelab Cluster

**Date:** 2026-07-19
**Scope:** OKE cluster (2× VM.Standard.A1.Flex, v1.35.2), all 19 namespaces, the
`gitops/`, `labs/`, and `terraform/` trees, and the OCI tenancy configuration.
**Method:** four parallel review sweeps (ingress/auth, RBAC/secrets, pod
security/network, cloud infra/OIDC), with load-bearing findings independently
re-verified against the live cluster before being recorded here.

> **Handling note:** no live credential values are reproduced in this document.
> Where a secret is described as disclosed, treat it as disclosed and rotate it;
> the value itself is deliberately omitted.

---

## Summary

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | 🔴 Critical | Lychee installer publicly reachable — unauthenticated admin takeover | Open |
| 2 | 🔴 Critical | `llm2.nirjon.xyz` serves LLM inference with no authentication | Open |
| 3 | 🔴 Critical | No network segmentation; Longhorn management API reachable from `lab` | Open |
| 4 | 🔴 Critical | mcp-bridge token written in cleartext to Envoy access logs | Open |
| 5 | 🟠 High | Grafana ServiceAccount can read every Secret cluster-wide | Open |
| 6 | 🟠 High | External Secrets holds tenancy-wide `manage secret-family` + `manage vault` | Open |
| 7 | 🟠 High | No Pod Security Admission enforcement in any namespace | Open |
| 8 | 🟡 Medium | All resources deployed into the tenancy root compartment | Open |
| 9 | 🟡 Medium | OKE Kubernetes API public on `0.0.0.0/0:6443` | Open |
| 10 | 🟡 Medium | `MyAdminsPolicy` grants `manage all-resources in tenancy`, not in Terraform | Needs decision |
| 11 | 🟡 Medium | Unauthenticated Redis in `boutique` | Open |
| 12 | 🟡 Medium | All `lab`/`boutique` workloads run as root, no `securityContext` | Open |
| 13 | 🟢 Low | No image digest pinning; `glance:latest` on a public endpoint | Open |
| 14 | 🟢 Low | Orphaned OCI LoadBalancer in `lab` (second billable LB) | Open |
| 15 | 🟢 Low | Dex serves plaintext HTTP behind Envoy | Accept or fix |

---

## 🔴 Critical

### 1. Lychee installer publicly reachable — unauthenticated admin takeover

`img.nirjon.xyz` sits in an unconfigured state and serves a live admin-creation
form to the internet with no authentication in front of it.

```
GET https://img.nirjon.xyz/            -> 307 -> /install/admin
GET https://img.nirjon.xyz/install/admin -> HTTP 200
     <title>Lychee Installer</title>
     "Set up admin account."  [username] [password]  "Create admin"
```

There is no `SecurityPolicy` targeting the `lychee` HTTPRoute
(`gitops/core/lychee/httproute.yaml`), and Lychee has no app-level auth until
setup completes. Anyone who loads that URL can claim the admin account and take
the instance, including the Longhorn-backed `lychee-photos` PVC (25Gi).

**External scanners have already found the host.** From the pod's own logs:

```
18/Jul/2026:16:20:06 "HEAD / HTTP/1.1" 204
  "... (compatible; +https://developers.cloudflare.com/security-center/)"
```

That is reconnaissance, not exploitation — but the host is indexed and being
probed.

**Exposure window.** The HTTPRoute is 106 days old, but `lychee-config` PVC is
5d7h and the pod 44h, so the unconfigured state most likely began roughly five
days ago rather than 106. Long enough to assume the account is claimable.

**Before anything else: check whether an admin account you do not recognize
already exists.** Treat the instance as potentially compromised until confirmed.

**Fix**
- Verify no rogue admin exists.
- Attach an OIDC `SecurityPolicy` to the `lychee` HTTPRoute (copy
  `gitops/core/longhorn/securitypolicy.yaml`, set
  `redirectURL: https://img.nirjon.xyz/oauth2/callback`).
- Complete the install behind the auth wall, or tear the deployment down.

**Related, same pod:** `TRUSTED_PROXIES=*` means Lychee trusts
`X-Forwarded-For` from any source, so client-IP logging and any IP-based
rate limiting there are spoofable.

---

### 2. `llm2.nirjon.xyz` serves LLM inference with no authentication

The `lab/llm-oidc` SecurityPolicy targets only `HTTPRoute/llm`. The `llm2`
route (`labs/llm/vibethinker-q4_0.yaml`) was added ~35h ago and never received
a matching policy.

Verified live with an unauthenticated request:

```
POST https://llm2.nirjon.xyz/v1/chat/completions   -> HTTP 200
  {"model":"/models/vibethinker-3b-q4_0.gguf", ... real generated tokens ... }

# for comparison, the protected sibling:
GET  https://llm.nirjon.xyz/  -> 302 -> login.nirjon.xyz/dex/auth
```

This is an oversight rather than a design decision — the correct pattern
already exists one route over.

**Impact:** free compute for anyone who finds the hostname; on a 2-OCPU
free-tier node measured at ~6 tok/s, a trivial request flood saturates the node
and degrades co-tenant workloads in `lab`. It is also an unauthenticated
foothold in the same namespace as the network position described in finding 3.
Note the `llm` HTTPRoute sets `timeouts.request: 0s` — no request cap.

**Fix:** add a `SecurityPolicy` mirroring `lab/llm-oidc` with
`targetRefs.name: llm2` and
`redirectURL: https://llm2.nirjon.xyz/oauth2/callback`. Consider the same for
`glance.nirjon.xyz` (currently 200, unauthenticated).

---

### 3. No network segmentation; Longhorn management API reachable from `lab`

The cluster has **4 NetworkPolicies, all in `flux-system`**. There is no
default-deny in any application namespace.

```
$ kubectl get networkpolicy -A
NAMESPACE     NAME                ...
flux-system   allow-egress
flux-system   allow-scraping
flux-system   allow-webhooks
flux-system   flux-operator-web
```

Verified from inside `pod/mcp-bridge-*` in namespace `lab` (read-only):

| Target | Result |
|---|---|
| `longhorn-backend.longhorn:9500/v1/settings` | **HTTP 200 — unauthenticated management API** |
| `longhorn-frontend.longhorn:80/v1/volumes` | **HTTP 200 — volume list with action URLs** |
| `kube-prometheus-stack-prometheus.monitoring:9090/api/v1/status/config` | HTTP 200 — full scrape config |
| `kube-prometheus-stack-alertmanager.monitoring:9093/api/v2/status` | HTTP 200 — receiver routing |
| `grafana.grafana:80/api/health` | HTTP 200 |
| `redis-cart.boutique:6379` | `+PONG` — unauthenticated |
| `10.0.1.84:9100/metrics` (node-exporter, hostNetwork) | HTTP 200 — host metrics |
| `kubernetes.default.svc` | reachable, **403** with pod SA token |

The Longhorn result is the most serious and is **new relative to the earlier
SSRF writeup**. Port 9500 is Longhorn's REST management API and ships with no
in-cluster authentication. The OIDC `SecurityPolicy` on `storage.nirjon.xyz`
protects only the *ingress* path; in-cluster the API is wide open.

**Blast radius:** a compromised pod in `lab` — a namespace whose whole purpose
is processing internet-fed content through an LLM and an external search proxy
— can detach, delete, or create-and-mount **any PVC in the cluster**, including
Prometheus and Lychee data. This is cluster-wide data destruction reachable
from the least-trusted namespace.

**Mitigating factor (verified good):** the mounted ServiceAccount token is
worthless. `kubectl auth can-i` as `system:serviceaccount:lab:default` returns
**no** for `get secrets` and `create pods`; the Kubernetes API leg is a dead
end. Do not over-prioritize the token — the network reachability is the issue.

**Not verified:** whether the Longhorn API accepts **writes** from `lab`. Reads
are confirmed. Destructive `POST`/detach operations were deliberately not
attempted against live storage. Given Longhorn ships no authn on 9500, writes
almost certainly succeed — confirm against a scratch volume before sizing the
risk.

**Fix**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: default-deny-ingress, namespace: lab}
spec: {podSelector: {}, policyTypes: [Ingress]}
```

plus an egress policy on `lab` allowing DNS and `0.0.0.0/0` **minus** the
cluster CIDRs via `ipBlock.except`: `10.96.0.0/16` (services),
`10.244.0.0/16` (pods), `10.0.0.0/16` (nodes). That single egress policy
eliminates every row in the table above while preserving the outbound internet
access the LLM and the Tavily bridge need.

Apply the same default-deny-ingress to `boutique` and `monitoring`.

> Apply this one interactively, not unattended — a mis-scoped egress rule will
> break the mcp-bridge's path to Tavily.

---

### 4. mcp-bridge token written in cleartext to Envoy access logs

The bridge authenticates callers with a shared token passed as a URL query
parameter (`/mcp?token=...`). That placement was chosen deliberately, to avoid
the CORS-preflight conflict with the OIDC reverse proxy documented in
`docs/mcp-bridge-case-study.md` — but it defeats the control.

The `EnvoyProxy` CR (`oracle-lb`) defines no `accessLog` block, so Envoy
Gateway's **default text access log** applies, and that format logs the full
request path including the query string. The token appears in the gateway pod
logs in cleartext, **110 occurrences** at time of audit.

**Impact:** the token is readable by anything that can read pod logs or scrape
container stdout, and it authorizes use of the Tavily API key. This is the
genuine weakness in the bridge design, and it is a flaw in the design as
originally implemented — not an operational mistake.

**Fix**
1. **Rotate the bridge token — treat the current value as disclosed.**
2. Either set a custom `accessLog` format that strips the query string, disable
   access logging for this route, or move the token to a header.
3. The cleaner long-term option: enforce the token in an Envoy `SecurityPolicy`
   (API-key auth) rather than in application code.

**Explicitly *not* findings on the bridge** — checked and dismissed, so they
don't get re-raised later:

- **Token strength: fine.** 48 hex chars ≈ 192 bits. Not brute-forceable.
- **Timing-safe comparison: not exploitable.** `server.js:66` uses `!==`, which
  is not constant-time, but remotely timing a JS string compare across the
  internet through Envoy is not practical at this entropy. Switching to
  `crypto.timingSafeEqual` is good hygiene, not a fix for anything real.
- **Rate limiting: absent, low priority** at 192-bit entropy — it matters only
  as defence-in-depth after the log leak is closed.
- **SSRF hardening: sound.** Fixed upstream destination, no client-supplied
  URL. Verified still in place (see Regression Checks).

---

## 🟠 High

### 5. Grafana ServiceAccount can read every Secret cluster-wide

`clusterrole/grafana-clusterrole` grants `secrets,configmaps: get,watch,list`
cluster-wide, bound to `system:serviceaccount:grafana:grafana`, which the
Grafana pod automounts.

Verified directly:

```
$ kubectl auth can-i list secrets --as=system:serviceaccount:grafana:grafana -A
yes
$ kubectl auth can-i get secrets -n external-secrets --as=system:serviceaccount:grafana:grafana
yes
```

**This permission is unnecessary.** `gitops/core/grafana/helm.yaml:77-85`
already sets `sidecar.dashboards.searchNamespace: grafana` and
`sidecar.datasources.searchNamespace: grafana` — the sidecars only ever read
their own namespace. The chart emits a ClusterRole purely because
`rbac.namespaced` is unset (defaults to `false`).

**Exploit chain:** Grafana is internet-facing at `monitoring.nirjon.xyz`. Any
Grafana RCE/SSRF or datasource/plugin abuse → read the projected SA token →
list Secrets cluster-wide → OCI Vault credentials, Teleport GitHub client
secret, Tailscale OAuth secret, Flux webhook token. This single binding
collapses the entire ESO/Vault design back into "everything readable from one
pod," and it is the only finding that is both internet-reachable and grants
cluster-wide secret access.

**Fix:** add `rbac: {namespaced: true}` under `values:` in
`gitops/core/grafana/helm.yaml`. Delete the stale `grafana-clusterrole` and
`grafana-clusterrolebinding` after reconcile.

---

### 6. External Secrets holds tenancy-wide `manage secret-family` + `manage vault`

`terraform/config/modules/external-secrets/iam.tf:39-42`:

```
"Allow group 'Default'/'VaultAdmins' to manage secret-family in tenancy"
"Allow group 'Default'/'VaultAdmins' to manage vault in tenancy"
```

Live-confirmed; group membership is the single `ExternalSecrets` user.
Authentication is a **long-lived user API key** (`principalType: UserPrincipal`),
not an instance principal. The RSA private key is generated by Terraform
(`iam.tf:14-22`) and written to a plain Opaque Secret (`vault_secrets.tf:19`),
so it exists in three places: the `external-secrets` namespace Secret, the
Terraform state in the `terraform-states` bucket, and any local plan output.

**ESO only ever reads.** `manage vault` would additionally permit deleting the
vault and KMS keys outright — destructive, and a homelab likely has no vault
backup.

**Fix**
- Narrow to `Allow group ... to read secret-family in compartment <x>`.
- Remove the `manage vault` statement entirely.
- Prefer an instance principal / workload identity dynamic group over a static
  API key, so there is no long-lived private key to steal.
- Rotate the current key — it has been in Terraform state.

---

### 7. No Pod Security Admission enforcement

The only PSA label in the cluster is `flux-system:
pod-security.kubernetes.io/warn=restricted` — **warn, not enforce, and only on
one namespace**. No third-party policy engine is present (the webhook list is
all cert-manager / ESO / Longhorn / Prometheus / OKE — no Kyverno, no
Gatekeeper).

Nothing prevents any workload, including a future one in `lab`, from requesting
`privileged: true` or a `hostPath: /` mount.

**Fix:**
`kubectl label ns lab boutique lychee dex s3-proxy pod-security.kubernetes.io/enforce=baseline`
— cheap, and blocks container-escape primitives in the namespaces that handle
untrusted input. Move `lab` to `enforce=restricted` after finding 12.

---

## 🟡 Medium

### 8. Everything deployed into the tenancy root compartment

`terraform/infra/terraform.tfvars` and `terraform/config/terraform.tfvars` both
set `compartment_id` to the tenancy OCID.

This is what makes finding 6 as severe as it is: every policy is written
`in tenancy`, and re-scoping "to compartment" would be a no-op because the
compartment *is* the tenancy. There is no blast-radius boundary anywhere.
It also causes finding 10's dynamic group to match every instance in the
account.

**Fix:** create a child compartment (e.g. `homelab`), move the VCN / OKE /
vault / buckets into it, re-scope all policies. More invasive than the others,
but it is what gives every least-privilege fix somewhere to stand.

### 9. OKE Kubernetes API public on `0.0.0.0/0:6443`

`terraform/infra/k8s.tf:6-9` (`is_public_ip_enabled = true`) and
`terraform/infra/subnets.tf:67-76` (ingress `0.0.0.0/0` → TCP 6443).
Live: public endpoint `134.185.81.22:6443`; a private endpoint
`10.0.0.212:6443` also exists.

The apiserver requires client certs / OIDC, so this is not an open door — but
it places the control plane's TLS and auth stack directly on the internet,
exposed to apiserver CVEs and credential stuffing. It is the highest-value
target in the estate.

**Fix:** narrow the 6443 ingress to your home/VPN egress CIDR. The private
endpoint already exists and Teleport is already deployed, so there is a viable
path in without public 6443.

### 10. `MyAdminsPolicy` — tenancy admin outside Terraform

Live only, no corresponding Terraform resource:

```
MyAdminsPolicy: "Allow group Default/MyAdmins to manage all-resources in tenancy"
```

A full tenancy-admin path parallel to `Administrators`, created out-of-band.
Group `MyAdmins` contains one user, `m1`. Mitigating: `m1` has MFA enabled, as
does the sole `Administrators` member.

**Action:** confirm `m1` is you and intentional. If leftover, delete the policy
and group. If intentional, codify it in Terraform — an admin path Terraform
doesn't know about won't be caught by drift review.

### 11. Unauthenticated Redis in `boutique`

`redis-cart.boutique:6379` answers `PING` from any pod cluster-wide. No auth,
no NetworkPolicy. Holds cart data — low intrinsic value, but it is a writable
network service usable as a pivot or persistence store. Covered by the
finding 3 default-deny.

### 12. All `lab` and `boutique` workloads run as root with no `securityContext`

Zero `securityContext` blocks across `labs/boutique/boutique.yaml` (all 11
services), `labs/glance/deployment.yaml`, `labs/llm/llama-server.yaml`,
`labs/llm/vibethinker-q4_0.yaml`, `labs/llm/mcp-bridge/deploy.yaml`.

No `privileged` / `hostPath` / `hostNetwork` in any of them, so escape requires
a kernel or runtime CVE — but `allowPrivilegeEscalation` unset is a free win.

**Fix**, per container:

```yaml
securityContext:
  allowPrivilegeEscalation: false
  runAsNonRoot: true
  capabilities: {drop: [ALL]}
  seccompProfile: {type: RuntimeDefault}
```

`readOnlyRootFilesystem: true` needs per-app testing (llama.cpp and glance
write temp files) — do that last.

---

## 🟢 Low

### 13. No image digest pinning

`grep -rn 'imagePullPolicy' gitops labs` → 0 hits.
`grep -rn '@sha256:' gitops labs` → 0 hits.

Floating tags on internet-exposed workloads:

| Image | Location |
|---|---|
| `docker.io/glanceapp/glance:latest` | `labs/glance/deployment.yaml` |
| `ghcr.io/ggml-org/llama.cpp:server` | `labs/llm/llama-server.yaml`, `labs/llm/vibethinker-q4_0.yaml` |
| `docker.io/node:22-alpine` | `labs/llm/mcp-bridge/deploy.yaml` |
| `docker.io/curlimages/curl:latest` | `labs/llm/vibethinker-q4_0.yaml` (init) |
| `docker.io/traefik/whoami` | no tag at all |

`glance:latest` is the sharpest — public, unauthenticated, and a silent
upstream compromise lands on the next reschedule with no git change. Flux
itself *is* correctly digest-pinned in-cluster, so the discipline exists; it
just isn't applied to `labs/`. Renovate is already configured
(`renovate.json`) and handles digest bumps.

### 14. Orphaned OCI LoadBalancer in `lab`

A second `LoadBalancer` service `envoy-envoy-gateway-envoy-e2d17690` exists in
namespace `lab` with external IP `140.245.102.56`, age 2d18h, duplicating the
real gateway service in `envoy-gateway`.

Verified safe to delete before recommending it:

```
DNS for llm / img / mcp-bridge / monitoring .nirjon.xyz  -> 138.2.99.247
  (= envoy-gateway/envoy-...  the real gateway)
Endpoints for lab/envoy-envoy-gateway-envoy-e2d17690     -> no addresses
```

It routes to nothing and no DNS record points at it, but it is a second public
IP and a billable flexible-shape OCI LB on a free-tier account. Likely left
behind by a namespace mixup.

### 15. Dex serves plaintext HTTP

`gitops/core/dex/helm.yaml:39-40` (`https.enabled: false`) and `:56`
(`http: 0.0.0.0:5556`); the HTTPRoute forwards to 5556. TLS terminates at
Envoy, so the Envoy→Dex hop carries authorization codes and ID tokens in
cleartext across the pod network. Minor in a single-tenant homelab, but Dex is
the trust root for every OIDC-protected service. Fix if convenient, otherwise
accept explicitly.

---

## ✅ Verified clean — no action needed

Recorded explicitly, because these are the controls that most often fail and
here they hold up.

**Secrets management**
- **No secrets in git.** All 14 secret manifests use `kind: ExternalSecret`
  with `secretStoreRef: {kind: ClusterSecretStore, name: oracle-vault}`. No
  `stringData:` anywhere. The two `kind: Secret` hits
  (`gitops/core/envoy-gateway/gateway.yaml:30`,
  `gitops/others/tailscale/helm.yaml:36`) are `certificateRefs` / `valuesFrom`
  references, not secret bodies.
- **Git history is clean.** `git log --all -G` over private keys, `tskey-`,
  `ghp_`, `github_pat_`, `ocid1.user.`, `tvly-`, `sk-*` — all five matching
  commits are placeholders, Terraform references, or CRD schema text. Nothing
  was committed and later removed.
- **`.gitignore` correct** for `*.tfstate*`, `*.tfvars*`, `*.env`,
  `.kube.config`; confirmed no such file was ever added in any commit.
- **State backend safe:** bucket `terraform-states` is `NoPublicAccess`,
  versioning **Enabled**, zero pre-authenticated requests. (No customer-managed
  KMS key — acceptable, though worth considering given finding 6 places an IAM
  private key in that state.)
- **Object storage private:** `access_type = "NoPublicAccess"`, live-confirmed
  on the `s3-proxy` bucket.

**Authentication**
- **Dex is well-configured** — this was the "compromises everything" dimension
  and it is sound. `enablePasswordDB: false`, no `staticPasswords` block
  anywhere, GitHub connector restricted to org `meislab` teams
  `admin`/`zuschauer` with `loadAllGroups: false`, and all three
  `staticClients` use **exact absolute HTTPS redirect URIs with no wildcards**.
  All client secrets come from OCI Vault via ExternalSecrets.
- **Both human admin accounts have MFA enabled.**
- **cert-manager uses production ACME**, DNS-01 via a Vault-sourced Cloudflare
  token. No staging issuer in the repo.
- **No TLS verification disabled anywhere.** Repo-wide grep for
  `insecureSkipVerify` / `skipTLSVerify` / `insecure_ssl` / `verify: false`
  returns one hit — `terraform/config/modules/fluxcd/webhook.tf:40`, which is
  `insecure_ssl = false`, the secure value.

**Ingress**
- `prometheus`, `storage` (Longhorn), `llm` — all 302 to Dex via
  `SecurityPolicy`. Correct.
- `s3.nirjon.xyz` — no SecurityPolicy, but s3-proxy enforces its own Dex OIDC
  (`307 → /auth/dex`). Correct.
- `monitoring.nirjon.xyz` (Grafana) — no SecurityPolicy, but self-protects via
  `[auth.generic_oauth]` against Dex with `disable_login_form = true` and
  `users.allow_sign_up = false`. Correct, given the Dex connector is org-scoped
  (confirmed above).
- `flux-webhook.nirjon.xyz` — 404 at `/` is correct; the Flux receiver
  validates a per-path HMAC token. Authenticated by design.
- `boutique.nirjon.xyz`, `whoami.nirjon.xyz` — intentionally public demo/echo
  apps, negligible value.
- Single Gateway, **one HTTPS listener on 443, no port-80 listener at all** —
  so no HTTP→HTTPS redirect, but also no plaintext surface, which is the safer
  of the two.

**RBAC**
- **`lab` default SA token is powerless** — verified `get secrets` → no,
  `create pods` → no. Confers only `system:authenticated` discovery.
- **No anonymous/unauthenticated escalation.** The only bindings to
  `system:anonymous` / `system:unauthenticated` / `system:authenticated` are
  the six stock Kubernetes ones.
- **Longhorn SA holds a cluster-admin escalation primitive**
  (`clusterroles,clusterrolebindings: *` plus `secrets: get,list,watch`;
  `can-i create clusterrolebindings` → **yes**). This is stock upstream
  Longhorn chart RBAC and cannot be trimmed without breaking CSI. Mitigating:
  the internet-exposed `longhorn-ui` pods use a *different* SA
  (`longhorn-ui-service-account`) which **cannot** list secrets, and
  `storage.nirjon.xyz` is OIDC-gated. **Accept, but treat `longhorn-manager` as
  a tier-0 workload** — keep it pinned and updated, don't colocate untrusted
  workloads.
- **Teleport `system:masters` path is correct design, not misconfiguration** —
  gated to GitHub org `meislab`, team `admin`. But it means cluster security
  reduces to that team's membership and 2FA posture. Enforce mandatory 2FA on
  the org.
- **Flux `cluster-admin` bindings** are inherent to how Flux applies arbitrary
  manifests. Not a finding.
- **Tailscale operator scope is reasonable** — no secrets access, no RBAC-write;
  the Connector advertises only `10.0.1.0/24`, not pod/service CIDRs.

**Network / infra**
- **NodePort range `0.0.0.0/0:30000-32767` is NOT internet-reachable.** It
  looks alarming but the security list attaches only to `k8s-private-subnet`,
  which has `prohibit-public-ip-on-vnic: true` and a NAT-only default route.
  No internet packet can reach it. This is the documented OCI NLB pattern. The
  rule is wider than necessary and would silently become a real exposure if a
  public IP or IGW route were added — worth narrowing to `10.0.0.0/24`, but not
  a live risk.
- **node-exporter** `hostNetwork`/`hostPID`/`hostPath` — legitimate and
  standard for that DaemonSet.
- **Longhorn CSI, flannel, kube-proxy, csi-oci-node, tailscale** — inspected,
  no excess privilege beyond requirement.
- **`deskx/`** — contains only `PLAN.md`, nothing deployed. Stated posture
  (localhost bind, Tailscale only, no public exposure) is sound.
- **OKE dashboard and Tiller add-ons are disabled.**

---

## Regression checks

Confirming prior remediation still holds (see
`docs/mcp-bridge-case-study.md`):

```
$ kubectl get statefulset -n lab llama-server -o jsonpath='{...args}'
["-m","/models/qwen3.5-2b-q4_0.gguf","--host","0.0.0.0","--port","8080",
 "--ctx-size","8192","--parallel","1","--n-gpu-layers","0","-t","2",
 "--threads-batch","2"]

$ kubectl get pods -A -o yaml | grep -iE 'webui-mcp-proxy|cors-origins'
(none found)
```

✅ The `--webui-mcp-proxy` SSRF remains closed on both LLM pods, with no stale
`--cors-origins` anywhere in the cluster. The bridge's fixed-destination
design is intact — its weakness is the token *transport* (finding 4), not the
SSRF hardening.

---

## Other observations (not security)

- **`vibethinker-3b-q4-0` is a naked Pod** with no owning controller — no
  self-healing, no rescheduling on node loss.
- **`vibethinker` lacks `--parallel 1`**, the flag that fixed the 4×-memory
  slot-reservation bug on `llama-server`. Less severe there because
  `--ctx-size` is 2048, but the same class of issue.
- **Config drift in boutique:** repo `labs/boutique/boutique.yaml:18` specifies
  `docker.io/redis:7-alpine`; the live pod runs
  `docker.io/redis:alpine@sha256:9d317178…`. That namespace is not fully
  GitOps-reconciled.
- **Infra drift:** live `k8s-public-subnet-sl` carries an ingress
  `0.0.0.0/0 → TCP 443` rule absent from `terraform/infra/subnets.tf`.
  Functionally correct (443 for the ingress LB is the point), but added
  out-of-band — a `terraform apply` may remove it and break ingress. Codify it.

---

## Remediation order

1. **Lychee** — check for a rogue admin account, then OIDC policy on `img`
   (or tear the deployment down). *Time-sensitive.*
2. **`llm2`** — add to the OIDC policy. *Time-sensitive.*
3. **Rotate the mcp-bridge token** + strip query strings from Envoy access logs.
4. **Grafana `rbac: {namespaced: true}`** — one line, largest RBAC win.
5. **Default-deny NetworkPolicy in `lab`** with egress `ipBlock.except` for
   cluster CIDRs — closes the entire finding-3 reach in one object. *Apply
   interactively; a mis-scoped egress rule breaks the bridge's path to Tavily.*
6. **ESO policy narrowing + API key rotation.**
7. Everything else is hardening: PSA labels, `securityContext` blocks, digest
   pinning, orphan LB deletion, compartment restructure, 6443 allowlist.

Items 1 and 2 are the urgent ones — both are unauthenticated internet-facing
exposures that can be closed with a single manifest each.
