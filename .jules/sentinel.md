## 2024-05-10 - Add Basic Security Headers and API Rate Limiting
**Vulnerability:** The Express server lacked basic HTTP security headers (like Content Security Policy, X-Frame-Options) and rate limiting, leaving it vulnerable to DoS attacks, brute force, and XSS/Clickjacking.
**Learning:** Security middleware like `helmet` and `express-rate-limit` are quick defense-in-depth measures. During dev in Vite environments, CSP needs to be disabled since Vite relies on inline scripts for HMR.
**Prevention:** Always wrap Express instances with standard security headers (e.g. `helmet()`) and limit request rates on public endpoints (e.g. `express-rate-limit`) from the onset of a new service.
