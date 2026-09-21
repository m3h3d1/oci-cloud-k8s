# Historical: Qwen3.5 Two-Replica LLM Deployment

## Scope

This records an earlier Qwen3.5-2B (Q4_0) deployment used to serve concurrent
queries from two nodes. It is not the current model deployment; consult
`labs/llm/` and the live cluster before using these instructions.

## Architecture

```
Cloudflare → envoy Gateway → Service (llama-server:8080)
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
            llama-server-0                   llama-server-1
             (worker node)                    (worker node)
                    │                               │
              RWO PVC-0 ─── (Longhorn CSI clone) ─── RWO PVC-1
```

- **StatefulSet** with `podManagementPolicy: Parallel` — both pods start simultaneously
- **`requiredDuringScheduling` pod anti-affinity** — guarantees one pod per node
- **Longhorn RWO PVCs** — each pod reads from its own local volume replica (zero network I/O at runtime)
- **Longhorn CSI Clone** — PVC-1 is an instant, bit-perfect copy of PVC-0

## The Journey

### Phase 1: Single-replica hostPath

Started with one replica on node `.84` using hostPath (`/var/lib/llama-models/model.gguf`). Simple, worked, but only used one node's CPU — the other sat idle.

### Phase 2: RWX PVC (failed)

Tried a single ReadWriteMany PVC backed by Longhorn's NFS share-manager. Both replicas would mount the same PVC.

**Problem:** Writing the 1.3 GB model file to the RWX PVC via `cp && sync` or `dd conv=fsync` consistently produced truncated files (260 MB, 432 MB, 501 MB — different each attempt). The NFS share-manager buffers writes in its page cache; `fsync` over NFS doesn't guarantee data reached Longhorn's backing store.

### Phase 3: Direct `kubectl exec` copy to RWO PVC (solved)

Switched to ReadWriteOnce PVC — no NFS, direct block device. But `kubectl run --overrides` with `dd`/`cp` in the command still truncated. Root cause: **JSON unicode escapes (`\u0026` for `&&`) inside `--overrides` mangled the shell command**, causing the copy tool to fail silently.

**Fix:** Start a sleep pod, then `kubectl exec` into it to run `cp` directly:

```bash
kubectl exec -n lab copy-helper -- sh -c '
  cp -v /source/model.gguf /dest/model.gguf 2>&1 && sync && echo "sync ok"
'
```

This produced a verified 1,296,764,000 byte copy — matching the source exactly.

### Phase 4: Longhorn CSI Clone for second replica

With the seed PVC `models-llama-server-0` populated, cloned it to `models-llama-server-1` via `dataSource`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: models-llama-server-1
  namespace: lab
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 2Gi } }
  storageClassName: longhorn
  dataSource:
    kind: PersistentVolumeClaim
    name: models-llama-server-0
```

The clone is a Longhorn-level metadata operation — completes in seconds regardless of file size.

### Phase 5: StatefulSet

Converted from Deployment to StatefulSet with `volumeClaimTemplates` matching the pre-created PVC names (`models-llama-server-{0,1}`). The StatefulSet adopts existing PVCs.

## Key Decisions

| Decision | Why |
|----------|-----|
| **RWO + clone** over RWX | NFS share-manager writes unreliable for large files; RWO is direct block device |
| **StatefulSet** over Deployment | Each pod needs its own PVC; volumeClaimTemplates + ordinal naming matches pre-created PVCs |
| **kubectl exec** over dd/cp in --overrides | JSON escaping in overrides caused silent truncation |
| **Qwen3.5-2B Q4_0** | Best accuracy/speed tradeoff on 2 vCPU ARM64 (MMLU Pro 55.3, ~9.9 tok/s per replica) |
| **CPU limit "2"** | Matches 2 vCPU; decode speed doubled vs limit "1" |
| **Memory limit 2560Mi** | Peak observed 1942 MiB, with 618 MiB headroom |

## Resource Impact

| Node | Before (1 replica) | After (2 replicas) | Headroom |
|------|-------------------|-------------------|----------|
| `.84` | 3.6 Gi used | 5.9 Gi used | 2.6 Gi |
| `.246` | 4.1 Gi used | 6.4 Gi used | 2.1 Gi |

Both nodes have >2 Gi free after adding the second replica.

## Verification Commands

```bash
# Pod placement
kubectl get pod -n lab -l app=llama-server -o wide

# Model file integrity
kubectl exec -n lab llama-server-0 -- wc -c /models/model.gguf
kubectl exec -n lab llama-server-1 -- wc -c /models/model.gguf

# Test inference
curl -s https://llm.nirjon.xyz/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"model","messages":[{"role":"user","content":"hi"}],"stream":false}' | head -c 200

# PVC status
kubectl get pvc -n lab -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,VOLUME:.spec.volumeName,ACCESS:.spec.accessModes,CAPACITY:.status.capacity.storage
```

## Pitfalls Documented

1. **Longhorn finalizers block PVC deletion.** `kubectl delete pvc --force` doesn't bypass the `protection` finalizer. Must patch: `kubectl patch pvc ... -p '{"metadata":{"finalizers":null}}' --type=merge`
2. **`kubectl run --overrides` JSON escaping.** `\u0026` for `&&` works in JSON but commands with shell redirections (`2>&1`, `<`) should be wrapped in `sh -c` and tested first. Prefer `kubectl exec` into a sleep pod for complex commands.
3. **NFS share-manager write buffering.** Longhorn RWX uses a pod-internal NFS server that buffers writes in its page cache. `fsync` across NFS doesn't guarantee durability. For large write-once files, seed via RWO and clone.
4. **Stale PVs accumulate.** Each failed deploy leaves a `Released` PV. Patch finalizers and force-delete before recreating PVCs with the same name.

## Model Download Blocked from OCI

HuggingFace downloads fail from the OCI cluster (CloudFront → Xet bridge returns 504/000). Workaround: cache the GGUF file on the first node's hostPath, then copy to PVC within the cluster. The hostPath model file was seeded by downloading on the local machine and transferring via a USB drive or `scp` (outside this repo's scope).
