# Historical: OKE Upgrade v1.34.2 → v1.35.2

## Why

OKE v1.34 reached end of life. Direct upgrade path available to v1.35.0 and v1.35.2
(chose the latter). External-secrets 1.3.2 was EOL and incompatible with K8s 1.35,
so it was upgraded to 2.7.0 first (separate operation).

## Steps taken

### Phase 1 — External-secrets upgrade

Upgraded `gitops/core/external-secrets/helm.yaml` version from `1.3.2` → `2.7.0`,
committed and pushed to `dev`. Flux picked it up and completed the upgrade. All 3 pods
(controller, cert-controller, webhook) running. No issues.

- **Why before OKE:** External-secrets 1.3.2 was EOL (Feb 2026) and incompatible with
  K8s 1.35. Upgrading first avoids a broken state after the control plane moves.

### Phase 2 — Terraform apply

Edited `terraform/infra/_variables.tf:25`:

```
default = "v1.34.2"  →  default = "v1.35.2"
```

Ran `terraform apply` (~7min).
- **Why:** This is the OCI Terraform provider's `oci_containerengine_cluster` resource.
  Changing `kubernetes_version` triggers an in-place control plane upgrade. The
  `oci_containerengine_node_pool` resource also updates its version and node image,
  but existing running instances are not touched — only new instances use the new config.
- This:
  - Upgraded the **control plane** to v1.35.2
  - Updated the **nodepool config** (K8s version + node OKE image)
  - Did **not** roll worker nodes (they stayed on v1.34.2)

### Phase 3 — Roll node 1 (10.0.1.112 → 10.0.1.246)

1. `k drain 10.0.1.112 --force --ignore-daemonsets --delete-emptydir-data`
   - **Why:** Safely evict all pods from the node so workloads move to the other node
     before we destroy it. `--force` bypasses certain checks, `--ignore-daemonsets`
     keeps DaemonSets running (they're node-level), `--delete-emptydir-data` allows
     evicting pods with emptyDir volumes.
   - Longhorn instance-manager PDB briefly blocked, retried, succeeded
2. `k cordon 10.0.1.112`
   - **Why:** Mark node as unschedulable so no new pods land on it during roll.
3. Found instance OCID via `oci compute instance list-vnics`
   - **Why:** The OCI instance needs to be terminated by ID. We looked up the VNIC
     to map private IP → instance OCID since the node name doesn't match the OCI
     instance display name.
4. `oci compute instance terminate --force --instance-id <id>`
   - **Why:** OKE won't recreate a node just because the Kubernetes Node object is
     deleted. You must terminate the underlying OCI compute instance. OKE detects
     the missing instance and provisions a replacement with the updated nodepool
     image and K8s version. `--force` skips the confirmation prompt.
5. Waited ~18s for new node `10.0.1.246` to appear at v1.35.2
6. Waited ~2min for it to become Ready
7. Waited ~3min for Longhorn volumes to rebuild and become healthy

### Phase 4 — Roll node 2 (10.0.1.241 → 10.0.1.84)

1. `k drain 10.0.1.241 --force --ignore-daemonsets --delete-emptydir-data`
   - Longhorn PDBs (`csi-attacher`, `csi-provisioner`, `instance-manager`) blocked
     eviction because `MIN AVAILABLE=1` and new node replicas weren't Ready yet
   - Removed PDBs temporarily: `kubectl delete pdb -n longhorn csi-attacher csi-provisioner instance-manager-d6884e8...`
     - **Why:** With `MIN AVAILABLE=1` and `ALLOWED DISRUPTIONS=0`, the scheduler
       won't evict the last running replica. Deleting the PDB removes the guard and
       lets drain proceed. Longhorn recreates PDBs automatically.
   - Drain then completed
2. `oci compute instance terminate --force` (async — took ~45s to reach `TERMINATED`)
3. Old node disappeared, new node `10.0.1.84` appeared at v1.35.2
4. Waited ~48s for Ready
5. Longhorn volumes rebuilt

### Phase 5 — Data recovery (lychee)

**3 Longhorn volumes** (`lychee-photos`, `lychee-config`, `lychee-sym`) were stuck in
`detached` + `faulted` state. Root cause: these volumes were configured with
`numberOfReplicas: 1` and the sole replica lived on the terminated node (10.0.1.241).
No backups existed.

**Recovery:**
1. Deleted stuck VolumeAttachments, PVs (with finalizer removal), and faulted Longhorn volumes
   - `kubectl delete volumeattachment <name>` — remove the CSI attachment so K8s stops
     trying to mount a dead volume
   - `kubectl patch pv <name> -p '{"metadata":{"finalizers":null}}' --type=merge` —
     PVs were stuck `Terminating` because Longhorn finalizers weren't cleaned up.
     Patching nulls out the finalizers forces deletion.
   - `kubectl delete volume -n longhorn <name>` — remove the Longhorn volume object
     for the faulted volume so a fresh one can be created
2. Set `default-replica-count` Longhorn setting from `1` → `2`
   - `kubectl patch settings.longhorn.io default-replica-count -n longhorn -p '{"value": "2"}' --type=merge`
   - **Why:** Prevents recurrence. New volumes will now have 2 replicas automatically.
3. Recreated PVCs (empty volumes)
   - Flux was stuck in `Reconciliation in progress` and not recreating PVCs, so they
     were applied manually from `gitops/core/lychee/storage.yaml`.
4. Lychee pod started normally with fresh (empty) volumes — data lost

**Why only these volumes?** The prometheus and teleport volumes had 2 replicas and
survived. The lychee volumes were provisioned when `default-replica-count` was `1`,
and the per-volume setting (`numberOfReplicas: 1`) was baked in at creation time.

## Technical challenges

### 1. Longhorn PDB blocking node drain

**Problem:** `k drain` got stuck on Longhorn CSI pods (`csi-attacher`,
`csi-provisioner`, `instance-manager`) protected by PDBs with `MIN AVAILABLE=1`
and `ALLOWED DISRUPTIONS=0`.

**Why:** The new node (10.0.1.246) had replacement pods still in `ContainerCreating`,
so the PDB saw 0 available replicas and blocked eviction of the old ones.

**Fix:** Removed the relevant PDBs temporarily, then drain completed. Longhorn
recreates PDBs automatically.

**Lesson:** For future node rolls, wait for CSI replacement pods on the remaining
node to become Ready before draining. Or accept that PDB deletion is part of the
process.

### 2. Lychee data loss — single replica volumes

**Problem:** 3 volumes had `numberOfReplicas: 1`. When the node with the only
replica was terminated, data was unrecoverable.

**Root cause:** `default-replica-count` Longhorn setting was `1` (set during
initial cluster setup). All new volumes inherited this. The StorageClass says
`numberOfReplicas: 2`, but that only applies to volumes created *after* the
StorageClass was updated — existing volumes keep their creation-time setting.

**Fix:**
- Changed `default-replica-count` to `2` to prevent recurrence
- New lychee volumes now have 2 replicas (one per node)

**Lesson:** `default-replica-count: 1` in a 2-node cluster means any single node
failure causes data loss for volumes with only one replica. This should have been
`2` from day one. Check this setting after initial cluster bootstrap.

### 3. PVC/PV stuck in Terminating

**Problem:** After deleting PVCs, they stayed in `Terminating` state because
Longhorn volumes and PVs still had finalizers.

**Fix:** Removed finalizers from PVs and PVCs manually:

```bash
kubectl patch pv <pv-name> -p '{"metadata":{"finalizers":null}}' --type=merge
kubectl patch pvc -n lychee <pvc-name> -p '{"metadata":{"finalizers":null}}' --type=merge
```

### 4. Flux not recreating PVCs

**Problem:** After stuck PVCs were force-deleted, Flux's lychee Kustomization was
in `Reconciliation in progress` but didn't recreate the PVCs.

**Fix:** Applied PVCs manually (same manifest from `gitops/core/lychee/storage.yaml`).
Once the manual PVCs were bound, Flux picked up and the deployment reconciled
normally.

**Lesson:** Flux Kustomization `prune: true` might have been confused by the stuck
Terminating PVCs. Applying PVCs manually was faster than debugging Flux.

## Configuration changes made

| Setting | Before | After |
|---|---|---|
| `kubernetes_version` | `v1.34.2` | `v1.35.2` |
| `default-replica-count` | `1` | `2` |

## Command reference

Every CLI command used during this upgrade, what it does, and why it was needed.

### Kubernetes

| Command | What it does | Why needed |
|---|---|---|
| `kubectl drain <node> --force --ignore-daemonsets --delete-emptydir-data` | Evicts all user pods from a node, then marks it unschedulable | Safely move workloads off a node before destroying it. `--force` bypasses certain checks, `--ignore-daemonsets` leaves node-level DaemonSets running, `--delete-emptydir-data` allows evicting pods with emptyDir volumes. |
| `kubectl cordon <node>` | Marks node as unschedulable (no new pods) | Prevents the scheduler from placing new workloads on a node being rolled. Implicitly done by `drain` but explicit for clarity. |
| `kubectl get nodes -o wide` | Lists nodes with extra detail (IP, version, OS, container-runtime) | Verify node versions after upgrade, check cri-o compatibility. |
| `kubectl get pods -A \| grep -v "Running\|Completed"` | Lists non-healthy pods across all namespaces | Quick health check — any pod not Running or Completed is a problem. |
| `kubectl get volumes.longhorn.io -n longhorn` | Lists Longhorn volume state/robustness | Verify all volumes are `healthy` after node roll. |
| `kubectl get replicas.longhorn.io -n longhorn` | Lists Longhorn replicas and their node placement | Verify replica distribution after rebuild (should be one per node). |
| `kubectl get kustomizations.kustomize.toolkit.fluxcd.io -A` | Lists Flux Kustomization status | Confirm all Flux-managed apps reconciled successfully after the upgrade. |
| `kubectl get events -n <ns> --sort-by=.lastTimestamp \| tail -10` | Shows recent events for a namespace | Debug stuck HelmRelease upgrades or pod scheduling failures. |
| `kubectl delete pdb -n longhorn <name>` | Removes a PodDisruptionBudget | Unblock node drain when PDB has `MIN AVAILABLE=1` and `ALLOWED DISRUPTIONS=0`. Longhorn recreates PDBs automatically. |
| `kubectl delete volumeattachment <name>` | Removes a CSI VolumeAttachment | Clean up stale attachments pointing to a deleted node so volumes can be recreated. |
| `kubectl patch pv <name> -p '{"metadata":{"finalizers":null}}' --type=merge` | Removes finalizers from a PV | Force-delete a PV stuck in `Terminating` because Longhorn finalizers weren't cleaned up. |
| `kubectl patch pvc -n <ns> <name> -p '{"metadata":{"finalizers":null}}' --type=merge` | Removes finalizers from a PVC | Same as PV — force-delete a PVC stuck in `Terminating`. |
| `kubectl delete volume -n longhorn <name>` | Deletes a Longhorn volume | Remove faulted/detached volumes so fresh ones can be provisioned. |
| `kubectl delete pvc -n <ns> <name>` | Deletes a PVC | Cascade-delete PVC → PV → Longhorn volume chain. |
| `kubectl patch settings.longhorn.io default-replica-count -n longhorn -p '{"value":"2"}' --type=merge` | Changes the global default replica count | Prevent future data loss by ensuring new volumes get 2 replicas instead of 1. |
| `kubectl wait --for=condition=Ready node/<name> --timeout=300s` | Blocks until a node becomes Ready | Wait for a replacement node to be fully operational before proceeding. |
| `kubectl delete pod -n <ns> <name> --force --grace-period=0` | Force-deletes a pod without waiting | Remove a pod stuck in `Terminating` or `ContainerCreating` so the deployment recreates it cleanly. |
| `kubectl annotate kustomization -n flux-system <name> reconcile.fluxcd.io/requestedAt="$(date +%s)" --overwrite` | Triggers an immediate Flux reconciliation | Tell Flux to reconcile a Kustomization right now instead of waiting for its interval (1h). |
| `kubectl logs -n flux-system -l app=<controller>` | Tails logs from a Flux controller pod | Debug why Flux isn't applying resources (source-controller, kustomize-controller, etc.). |

### OCI CLI

| Command | What it does | Why needed |
|---|---|---|
| `oci ce cluster get --cluster-id <id> \| jq -r '.data."available-kubernetes-upgrades"'` | Lists available K8s versions for upgrade | Check which versions OKE allows as a direct upgrade path before editing terraform. |
| `oci compute instance list-vnics --instance-id <id>` | Lists VNICs (virtual NICs) for a compute instance | Map private IP to instance OCID — needed because `kubectl get nodes` shows IP but `oci` commands need instance OCID. |
| `oci compute instance terminate --force --instance-id <id>` | Terminates a compute instance (async) | Trigger OKE to replace the node. OKE detects the missing instance and provisions a new one with the updated nodepool config. |

### Terraform

| Command | What it does | Why needed |
|---|---|---|
| `terraform apply` | Applies infrastructure changes declared in `.tf` files | Upgrades the OKE cluster and nodepool to the new K8s version. `oci_containerengine_cluster` and `oci_containerengine_node_pool` are updated in-place. |
| `terraform output --raw <name>` | Prints a terraform output value | Get cluster_id, compartment_id, etc. for use in `oci` commands. |

### git

| Command | What it does | Why needed |
|---|---|---|
| `git commit -a -m "..." && git push` | Commit and push changes to the remote | Flux watches the git repo for changes. Pushing triggers reconciliation of HelmRelease versions, Kustomization paths, etc. |

### jq

| Command | What it does | Why needed |
|---|---|---|
| `jq -r '.data[] \| select(."private-ip"=="<ip>") \| .id'` | Filters and extracts values from JSON | Parse `oci` JSON output to find instance OCID by private IP. |

## End State At Completion

- **Control plane:** v1.35.2
- **Nodes:** 2x `VM.Standard.A1.Flex`, both v1.35.2, cri-o 1.35.2
- **Longhorn:** 5 volumes, all healthy, 2 replicas each
- **Pods:** All Running
- **Flux:** All Kustomizations Ready
- **Lychee:** Running with fresh (empty) volumes — photos need re-upload
