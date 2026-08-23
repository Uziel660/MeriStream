import re

with open("server.ts", "r") as f:
    content = f.read()

# Sonar might complain about:
# 1. Unused or generic error in catch (err) -> catch (err: any) or just catch { ... }?
# Actually in TS, catch (err) is fine, but `err` is implicitly `any` or `unknown`. Let's just do `catch` or `catch (err: unknown)` or don't declare it.
content = content.replace("} catch (err) {", "} catch {")
content = content.replace("} catch (error) {", "} catch {")
content = content.replace("} catch (e) {", "} catch {")

old_block = """      const isPrivate =
        resolvedIp === "localhost" ||
        resolvedIp === "::1" ||
        resolvedIp === "::" ||
        resolvedIp.startsWith("::ffff:") ||
        resolvedIp.startsWith("fc00:") ||
        resolvedIp.startsWith("fd") ||
        resolvedIp.startsWith("fe80:") ||
        resolvedIp.startsWith("127.") ||
        resolvedIp.startsWith("10.") ||
        resolvedIp.startsWith("192.168.") ||
        resolvedIp.startsWith("169.254.") ||
        resolvedIp.startsWith("0.") ||
        (resolvedIp.startsWith("172.") && (() => { const p = parseInt(resolvedIp.split(".")[1], 10); return p >= 16 && p <= 31; })());"""

new_block = """      let isPrivate = false;
      if (
        resolvedIp === "localhost" ||
        resolvedIp === "::1" ||
        resolvedIp === "::" ||
        resolvedIp.startsWith("::ffff:") ||
        resolvedIp.startsWith("fc00:") ||
        resolvedIp.startsWith("fd") ||
        resolvedIp.startsWith("fe80:") ||
        resolvedIp.startsWith("127.") ||
        resolvedIp.startsWith("10.") ||
        resolvedIp.startsWith("192.168.") ||
        resolvedIp.startsWith("169.254.") ||
        resolvedIp.startsWith("0.")
      ) {
        isPrivate = true;
      } else if (resolvedIp.startsWith("172.")) {
        const p = parseInt(resolvedIp.split(".")[1], 10);
        if (p >= 16 && p <= 31) {
          isPrivate = true;
        }
      }"""

if old_block in content:
    content = content.replace(old_block, new_block)

with open("server.ts", "w") as f:
    f.write(content)
