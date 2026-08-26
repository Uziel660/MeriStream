## 2024-11-28 - SSRF IP Validation Bypass in Proxy Endpoint
**Vulnerability:** The `/api/v1/proxy/stream` endpoint validated IP addresses by checking string prefixes (e.g., `resolvedIp.startsWith("127.")`) returned by `dns.lookup`. This fails to correctly validate all IP representations and ranges (like Multicast `224.0.0.0/4`).
**Learning:** String-matching IP addresses is brittle and fails against specific IP representations or alternative reserved address blocks that are not strictly matched by the prefix.
**Prevention:** Always use Node.js's built-in `net` module (`net.isIPv4` and `net.isIPv6`) to structurally parse IP addresses into numerical octets before evaluating their range logic.
