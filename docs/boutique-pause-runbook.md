# Temporarily pause Boutique

Use this runbook to free the Boutique demo's resources for a short-lived test.
It scales the namespace's Deployments to zero but does not delete Services,
configuration, or persistent data.

## Pause Boutique

```sh
kubectl scale deployment --all -n boutique --replicas=0
kubectl wait --for=delete pod --all -n boutique --timeout=120s
kubectl top nodes
```

## Restore Boutique

```sh
kubectl scale deployment --all -n boutique --replicas=1
kubectl wait --for=condition=available deployment --all -n boutique --timeout=180s
```

The Boutique demo is unavailable while its Deployments are scaled to zero.
