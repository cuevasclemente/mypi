---
name: linux-network-reachability-troubleshooting
description: Diagnose Linux hosts unreachable on LAN/VPN, especially dual-homed same-subnet wired+Wi-Fi ARP flux, rp_filter/firewalld drops, mDNS/Avahi confusion, NetworkManager route metrics/autoconnect issues, and VPN/WireGuard/Defguard stale handshake symptoms.
---

# Linux Network Reachability Troubleshooting

Use this skill when a Linux host is intermittently or fully unreachable over LAN, SSH, hostname/mDNS, VPN, WireGuard, or Defguard, especially when the host has both wired and Wi-Fi active on the same subnet.

## Core mental model

Unreachability is often not "the network is down". Common causes:

- **Dual-homed same-subnet ARP flux:** wired and Wi-Fi both active on the same LAN, e.g. `192.168.50.225` on Ethernet and `192.168.50.64` on Wi-Fi. Peers may ARP one IP but packets arrive on the other interface.
- **Reverse-path filtering / firewalld rpfilter:** kernel or firewall drops packets that arrive on an unexpected interface, e.g. packets to the Wi-Fi IP arrive on wired.
- **NetworkManager policy conflicts:** route metrics, duplicate default routes, autoconnect behavior, and logs showing device/connection conflict churn.
- **Hostname/mDNS confusion:** Avahi may publish many Docker, bridge, veth, or VPN addresses, making `host.local` resolve to an unusable address.
- **VPN/WireGuard symptoms:** containers/gateways/DNS may be up while WireGuard handshakes are stale, so control-plane health is not proof of tunnel reachability.

## Safety and sudo caveat

Prefer read-only diagnostics first. Many useful commands need no sudo. Commands that change NetworkManager, firewall, sysctl, containers, or systemd state may require sudo and should be explained before running.

Do not claim that a fallback or auto-healing setup is complete unless it is privileged and persistent. A true wired/Wi-Fi fallback usually needs a **NetworkManager dispatcher script**, **systemd timer/service**, or equivalent privileged mechanism; a one-time `nmcli` command only changes current state/configuration.

## Fast triage checklist

1. Establish the symptom precisely:
   - IP unreachable, hostname unreachable, SSH refused/timed out, VPN peer unreachable, or intermittent failures?
   - From which source host/network does it fail?
   - Does direct IP work while hostname fails?
2. Inventory interfaces and routes.
3. Check listeners and local firewall.
4. Inspect NetworkManager and kernel logs.
5. Check ARP/neigh tables from both ends where possible.
6. Look for rp_filter/firewalld cross-interface drops.
7. Check DNS/mDNS/Avahi answers.
8. Check VPN/WireGuard/Defguard control plane and handshake freshness.
9. Apply minimal mitigation.
10. Validate from another host.

## Inventory commands

Run on the affected Linux host:

```bash
hostnamectl
ip -brief address
ip route
ip rule
nmcli device status
nmcli connection show --active
nmcli -f NAME,UUID,TYPE,DEVICE,AUTOCONNECT connection show
nmcli -f GENERAL,IP4,IP6 device show
```

Look for:

- Two active LAN interfaces in the same subnet, especially Ethernet + Wi-Fi.
- Multiple default routes with similar or unexpected metrics.
- Wi-Fi autoconnect enabled even though wired should be primary.
- Docker/bridge/veth/tunnel interfaces that may affect DNS or Avahi publication.

## SSH and service listener checks

On the affected host:

```bash
ss -ltnp
systemctl status ssh sshd --no-pager
journalctl -u ssh -u sshd --since '1 hour ago' --no-pager
```

From another host:

```bash
ping -c 3 <ip>
nc -vz <ip> 22
ssh -vvv <user>@<ip>
```

Interpretation:

- `connection refused`: host reachable, service not listening or firewall rejecting.
- `timeout`: routing, ARP, firewall drop, rp_filter, VPN path, or wrong address.
- Direct IP works but hostname fails: DNS/mDNS/Avahi issue.

## Logs to inspect

```bash
journalctl -k --since '2 hours ago' --no-pager
journalctl -u NetworkManager --since '2 hours ago' --no-pager
journalctl -u firewalld --since '2 hours ago' --no-pager
```

Search for:

- NetworkManager activation/deactivation loops.
- Wi-Fi and wired connections competing on same subnet.
- `rpfilter`, `reverse path`, `martian`, `DROP`, `REJECT`, or interface mismatch messages.
- Firewall zone changes when interfaces reconnect.

## ARP/neigh and same-subnet dual-homing

On the affected host:

```bash
ip neigh show
ip -s link
```

From a peer on the LAN:

```bash
ip neigh show | grep -E '<host-ip>|<hostname>'
arp -an | grep '<host-ip>'
```

If packets to the Wi-Fi IP are observed arriving on the wired interface, or peers learn inconsistent MAC addresses for the host's IPs, suspect ARP flux / asymmetric return path.

Helpful deeper checks when appropriate:

```bash
sudo tcpdump -ni any 'arp or host <peer-ip>'
sudo tcpdump -ni <wired-iface> 'host <peer-ip>'
sudo tcpdump -ni <wifi-iface> 'host <peer-ip>'
```

Explain before running tcpdump with sudo.

## firewalld and rp_filter checks

```bash
sysctl net.ipv4.conf.all.rp_filter
sysctl net.ipv4.conf.default.rp_filter
sysctl net.ipv4.conf.<iface>.rp_filter
firewall-cmd --state
firewall-cmd --get-active-zones
firewall-cmd --list-all-zones
```

Interpretation:

- Strict rp_filter can drop asymmetric traffic on multi-interface hosts.
- firewalld rpfilter or zone/interface mismatch can drop packets that arrive on the "wrong" interface.
- Do not disable protections blindly. Prefer fixing topology/autoconnect/route metrics first; only change rp_filter/firewall with user approval and a rollback plan.

## DNS, hostname, mDNS, and Avahi

Check what names resolve to from the client and the host:

```bash
getent hosts <hostname>
getent hosts <hostname>.local
resolvectl query <hostname>
resolvectl query <hostname>.local
avahi-resolve-host-name <hostname>.local
```

On the affected host:

```bash
hostname
hostname -I
ip -brief address
systemctl status avahi-daemon --no-pager
journalctl -u avahi-daemon --since '2 hours ago' --no-pager
```

Watch for Avahi publishing Docker, veth, bridge, VPN, or stale addresses. If `hostname.local` resolves to an unreachable Docker/veth/VPN address, use direct IP for validation and then adjust Avahi/interface publication policy.

## VPN, WireGuard, and Defguard checks

Control-plane services can be healthy while tunnels are stale. Check both service/container status and cryptographic handshake freshness.

```bash
wg show
ip route
ip rule
ss -lunp | grep -E 'wireguard|wg|51820|51821'
```

For Defguard/containerized setups, adapt names to the deployment:

```bash
docker ps
docker logs --tail=200 <defguard-container>
docker logs --tail=200 <gateway-or-dnsmasq-container>
```

Look for:

- Defguard gateway and dnsmasq active but WireGuard `latest handshake` old or absent.
- Endpoint address/port wrong or unreachable.
- AllowedIPs not covering the target.
- Routes for VPN subnets missing or overridden by LAN routes.
- DNS points clients to VPN names/addresses that are not currently reachable.

## Minimal mitigation for same-subnet wired + Wi-Fi conflict

If wired is the intended primary LAN path and Wi-Fi is only causing conflict, the quickest safe mitigation is to disconnect Wi-Fi and disable its autoconnect:

```bash
nmcli device disconnect wlan0
nmcli connection modify '<WiFi connection name>' connection.autoconnect no
```

Then confirm:

```bash
ip -brief address
ip route
nmcli device status
nmcli connection show --active
```

If the Wi-Fi interface name or connection name differs, discover it with `nmcli device status` and `nmcli connection show` first.

## Designing true fallback

If the user wants Wi-Fi fallback when wired is down:

- Do not leave wired and Wi-Fi simultaneously active on the same subnet unless policy routing/ARP behavior/firewall are deliberately configured.
- Prefer NetworkManager priorities/route metrics only when they solve the actual traffic path without ARP flux.
- For robust fallback, propose a privileged NetworkManager dispatcher script or systemd timer/service that:
  - Detects wired carrier/default-route health.
  - Enables Wi-Fi only when wired is down or unhealthy.
  - Disconnects Wi-Fi when wired returns.
  - Logs actions to journald.
  - Has clear rollback commands.
- Call out that this requires sudo/root installation and maintenance.

## Validation from another host

After each mitigation, validate externally, not only from the affected host:

```bash
ping -c 3 <wired-ip>
nc -vz <wired-ip> 22
ssh <user>@<wired-ip> hostname
getent hosts <hostname> <hostname>.local
ip neigh show | grep '<wired-ip>'
```

For VPN paths:

```bash
ping -c 3 <vpn-ip>
nc -vz <vpn-ip> 22
wg show
```

Success criteria:

- One intended LAN IP is reachable consistently.
- SSH/listener test succeeds from another host.
- ARP/neigh entry maps to the expected interface/MAC.
- NetworkManager no longer shows same-subnet active conflict unless intentionally configured.
- No fresh rpfilter/firewalld drops for the tested traffic.
- Hostname resolves to the address that actually works, or users know to use the direct IP until DNS/mDNS is fixed.
- WireGuard handshake is fresh when validating VPN reachability.

## Reporting template

When handing off findings, include:

- Active interfaces/IPs and default routes.
- Whether wired + Wi-Fi are both active on the same subnet.
- SSH/listener status.
- Relevant NetworkManager/kernel/firewalld log evidence.
- DNS/mDNS answer vs working direct IP.
- VPN/WireGuard handshake age and route status, if relevant.
- Minimal change applied or recommended.
- Remaining risks and rollback/fallback plan.
