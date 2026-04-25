# Glance Lab

This directory contains the Kustomize manifests for deploying Glance in the `lab` namespace.

## Usage

This setup uses **Kustomize**. Instead of applying individual YAML files, you apply the entire directory. This allows for automatic configuration injection and rolling restarts when configuration files change.

### 1. Deploy or Update
To deploy the application for the first time, or to apply changes made to the `config/` or `assets/` directories:

```bash
kubectl apply -k labs/glance -n lab
```

*Note: Kustomize will automatically detect changes in your configuration files, generate new hashed ConfigMaps, and trigger a rolling update of the Glance pod.*

### 2. Monitoring

**Check Pod status:**
```bash
kubectl get pods -n lab -l app=glance
```

**View live logs:**
```bash
kubectl logs -n lab -l app=glance -f
```

**Check all resources in the lab namespace:**
```bash
kubectl get all -n lab
```

### 3. Cleanup
To completely remove the Glance deployment and all its associated resources:

```bash
kubectl delete -k labs/glance -n lab
```

## Local Development
For local testing outside of the cluster, you can use Docker Compose:

```bash
cd labs/glance
docker compose up -d
```
