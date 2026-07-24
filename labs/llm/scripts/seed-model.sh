#!/bin/bash
# Seeds the model from hostPath on node .84 to a Longhorn PVC,
# then clones it for the second replica.
# Relies on kubectl exec (not dd/cp inside overrides) which avoids
# JSON-escaping bugs that previously caused silent truncation.
set -euo pipefail

NAMESPACE="lab"
SOURCE_NODE="10.0.1.84"
SEED_PVC="models-llama-server-0"
CLONE_PVC="models-llama-server-1"
MODEL_NAME="qwen3.5-2b-q4_0.gguf"

cleanup_pvc() {
  local name=$1
  kubectl delete pvc -n $NAMESPACE $name --grace-period=0 --force 2>/dev/null || true
  kubectl patch pvc -n $NAMESPACE $name -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
}

echo "=== Cleaning up old PVCs ==="
cleanup_pvc $SEED_PVC
cleanup_pvc $CLONE_PVC
for i in $(seq 1 30); do
  if ! kubectl get pv -o name 2>/dev/null | grep -E "$SEED_PVC|$CLONE_PVC" >/dev/null; then
    break
  fi
  sleep 5
done

echo "=== Creating seed PVC: $SEED_PVC ==="
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $SEED_PVC
  namespace: $NAMESPACE
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 2Gi
  storageClassName: longhorn
EOF

kubectl wait -n $NAMESPACE --for=jsonpath='{.status.phase}'=Bound pvc/$SEED_PVC --timeout=60s

echo "=== Starting copy pod on $SOURCE_NODE ==="
kubectl run -n lab copy-helper --image=docker.io/ubuntu:24.04 --restart=Never \
  --overrides='{
    "spec":{"nodeSelector":{"kubernetes.io/hostname":"'$SOURCE_NODE'"},
      "containers":[{"name":"helper","image":"docker.io/ubuntu:24.04",
        "command":["sleep","600"],
        "volumeMounts":[{"mountPath":"/source","name":"src"},{"mountPath":"/dest","name":"dst"}]}],
      "volumes":[{"name":"src","hostPath":{"path":"/var/lib/llama-models","type":"Directory"}},{"name":"dst","persistentVolumeClaim":{"claimName":"'$SEED_PVC'"}}]}
  }' 2>/dev/null

kubectl wait -n $NAMESPACE --for=condition=ready pod/copy-helper --timeout=60s

echo "=== Copying model (this takes ~15s) ==="
kubectl exec -n lab copy-helper -- sh -c '
  cp -v /source/'"$MODEL_NAME"' /dest/'"$MODEL_NAME"' 2>&1 && sync && echo "sync ok"
'

echo "=== Verifying seed PVC ==="
kubectl exec -n lab copy-helper -- ls -lh /dest/$MODEL_NAME

echo "=== Cleaning up copy pod ==="
kubectl delete pod -n lab copy-helper --grace-period=0 --force 2>/dev/null

echo "=== Cloning to $CLONE_PVC ==="
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $CLONE_PVC
  namespace: $NAMESPACE
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 2Gi
  storageClassName: longhorn
  dataSource:
    kind: PersistentVolumeClaim
    name: $SEED_PVC
EOF

kubectl wait -n $NAMESPACE --for=jsonpath='{.status.phase}'=Bound pvc/$CLONE_PVC --timeout=120s

echo "=== Done ==="
echo ""
echo "PVCs ready:"
kubectl get pvc -n $NAMESPACE -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,ACCESS:.spec.accessModes,CAPACITY:.status.capacity.storage | grep "models-llama"
echo ""
echo "Next steps:"
echo "  1. kubectl delete deployment -n lab llama-server"
echo "  2. kubectl apply -f labs/llm/llama-server.yaml"
echo "  3. kubectl rollout status -n lab statefulset/llama-server"
