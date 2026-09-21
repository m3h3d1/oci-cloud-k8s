# Right-Sizing Online Boutique

## Purpose

Online Boutique's upstream resource values were sized for a general x86 demo,
not this ARM64 homelab. Requests reserve scheduler capacity; limits cap runtime
use. The goal was to reduce idle reservations without removing burst headroom.

This is a historical measurement and change record. Re-measure before changing
these values again.

## Findings

The pre-change snapshot showed low real usage but high CPU reservations:

| Workload | Observed idle CPU / memory | Previous request |
| --- | --- | --- |
| adservice | 2m / 71Mi | 200m / 180Mi |
| cartservice | 2m / 36Mi | 200m / 128Mi |
| Other services | about 1m / 7-36Mi | 100m / 64Mi |
| redis | 8m / 9Mi | none |

The scheduler reserved about 1,300m CPU and 948Mi memory for the namespace,
although the services were mostly idle. Redis was `BestEffort` because it had
no resources, making it the first candidate for eviction under pressure.

## Applied Resources

| Workload | Request | Limit |
| --- | --- | --- |
| adservice | 25m / 96Mi | 100m / 192Mi |
| cartservice | 25m / 64Mi | 100m / 128Mi |
| currencyservice, emailservice, recommendationservice | 10m / 48Mi | 50m / 96Mi |
| checkoutservice, frontend, paymentservice, productcatalogservice, shippingservice | 10m / 32Mi | 50m / 96Mi |
| redis | 25m / 32Mi | 100m / 96Mi |

The resulting namespace requests were 145m CPU and 516Mi memory. Redis moved
from `BestEffort` to `Burstable`.

## Validate Before Changing

```sh
# Live workload usage
kubectl top pods -n boutique

# Scheduler reservations and node pressure
kubectl describe node <node>

# Pod QoS classes
kubectl get pods -n boutique \
  -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass

# CPU throttling for a suspect workload
kubectl exec -n boutique deploy/adservice -- cat /sys/fs/cgroup/cpu.stat
```

Use sustained or peak measurements, not a cold-start snapshot. A reasonable
starting point is a request near P99 usage plus 20-50% headroom, with a limit
two to three times the request. Memory limits need extra care: exceeding one
causes an OOM kill, while CPU limits throttle.

## ARM64 Notes

- Boutique images use the ARM64 build at
  `ghcr.io/m3h3d1/microservices-demo:arm64-2026-04-12-v2`; Redis uses the
  multi-architecture `redis:7-alpine` image.
- `currencyservice` and `paymentservice` require `DISABLE_PROFILER=1` because
  the profiler's native dependency has no `linux-arm64-musl` binary.
- The ARM64 service images do not include `grpc_health_probe`; their manifests
  use `tcpSocket` probes instead of the upstream `exec` probes.

The manifests are in `labs/boutique/boutique.yaml`.
