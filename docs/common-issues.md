# Common Issues

## DNS: `DNS_PROBE_FINISHED_NXDOMAIN` after adding HTTPRoute

**Cause:** Record live at Cloudflare, but cached as NXDOMAIN in Tailscale DNS (`172.16.4.1`) and/or systemd-resolved.

**Fix (flush both):**
```bash
sudo systemctl restart tailscaled
sudo resolvectl flush-caches
```

**Debug flow:**
```bash
dig @1.1.1.1 +short <hostname>   # authoritative check
resolvectl status                 # which DNS server?
dig +short <hostname>             # local resolution
```
