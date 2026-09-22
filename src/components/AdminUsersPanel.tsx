import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck, UserRound } from 'lucide-react';

interface AdminUser {
  id: string;
  username: string;
  avatar?: string | null;
  is_admin: boolean;
  created_at?: string;
}

export default function AdminUsersPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/v1/admin/users', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('No se pudieron cargar los usuarios.');
      const data = await response.json();
      setUsers(Array.isArray(data.users) ? data.users : []);
      setError(null);
    } catch (loadError: any) {
      setError(loadError?.message || 'No se pudieron cargar los usuarios.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (user: AdminUser) => {
    setSavingId(user.id);
    try {
      const response = await fetch(`/api/v1/admin/users/${encodeURIComponent(user.id)}/role`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_admin: !user.is_admin }),
      });
      if (!response.ok) throw new Error('No se pudo guardar el permiso.');
      const data = await response.json();
      setUsers((current) => current.map((item) => item.id === user.id ? data.user : item));
    } catch (saveError: any) {
      setError(saveError?.message || 'No se pudo guardar el permiso.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sky-400/10 text-sky-300"><ShieldCheck size={17} /></span>
          <div>
            <h3 className="text-sm font-bold text-white">Usuarios y permisos</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">Activa el acceso administrativo para una cuenta normal. Ese usuario podrá abrir el panel y, si activa la preferencia correspondiente, ver los identificadores en el catálogo.</p>
          </div>
        </div>
      </div>
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</div>}
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/40">
        {loading ? <div className="flex items-center gap-2 p-5 text-xs text-zinc-500"><Loader2 size={14} className="animate-spin" /> Cargando usuarios…</div> : users.length === 0 ? <div className="p-5 text-xs text-zinc-500">No hay usuarios registrados.</div> : users.map((user) => (
          <div key={user.id} className="flex items-center justify-between gap-3 border-b border-zinc-800/70 px-4 py-3 last:border-b-0">
            <div className="flex min-w-0 items-center gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-zinc-800 text-zinc-400"><UserRound size={14} /></span><div className="min-w-0"><p className="truncate text-xs font-semibold text-white">{user.username}</p><p className="text-[10px] text-zinc-500">{user.is_admin ? 'Administrador' : 'Usuario normal'}</p></div></div>
            <button type="button" onClick={() => void toggle(user)} disabled={savingId === user.id} className={`rounded-lg px-3 py-2 text-[11px] font-semibold transition-colors ${user.is_admin ? 'border border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20' : 'border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-sky-400/40 hover:text-sky-200'} disabled:cursor-wait disabled:opacity-60`}>
              {savingId === user.id ? <Loader2 size={13} className="animate-spin" /> : user.is_admin ? 'Quitar admin' : 'Dar admin'}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
