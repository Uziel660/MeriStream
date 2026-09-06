import "dotenv/config";
import { prisma } from "../server/db";

const user = process.env.ADMIN_USER?.trim() || "";
const password = process.env.ADMIN_PASS || "";
const login = await fetch("http://127.0.0.1:3010/api/v1/admin/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ user, password }),
});
if (!login.ok) {
  console.log(JSON.stringify({ loginHttp: login.status }));
} else {
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] || "";
  const response = await fetch("http://127.0.0.1:3010/api/v1/verification", { headers: { cookie } });
  const payload = await response.json();
  console.log(JSON.stringify({
    statusHttp: response.status,
    running: payload.running,
    phase: payload.phase,
    done: payload.progress?.done,
    total: payload.progress?.total,
    errors: payload.progress?.errors,
    newWorks: payload.progress?.new_works,
    known: payload.progress?.known,
    updatedMetadata: payload.progress?.updated_metadata,
    newEpisodes: payload.progress?.new_episodes,
    sourcesAdded: payload.progress?.sources_added,
    startedAt: payload.started_at,
    updatedAt: payload.updated_at,
    currentItem: payload.current_item,
    recent: payload.recent?.slice(0, 5),
    config: payload.config,
    syncKnownEpisodes: payload.config?.sync_known_episodes,
    metadataOnly: payload.config?.metadata_only,
  }, null, 2));
}
const groups = await prisma.crawlTask.groupBy({
  by: ["scope", "status"],
  _count: { _all: true },
  _sum: { total_discovered: true, shows_imported: true, episodes_imported: true },
});
console.log(JSON.stringify({ crawlTaskGroups: groups }));
await prisma.$disconnect();
