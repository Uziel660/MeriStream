import React, { useState, useEffect } from 'react';
import { Plus, Lock } from 'lucide-react';

interface Profile {
  id: string;
  name: string;
  avatar_id: string;
  pin: string | null;
}

interface LoginProps {
  onLogin: (profile: Profile) => void;
}

// Avatares disponibles (puedes expandirlo o usar URLs de imágenes)
const AVATARS = [
  'bg-blue-500',
  'bg-red-500',
  'bg-green-500',
  'bg-yellow-500',
  'bg-purple-500',
  'bg-pink-500',
];

export function Login({ onLogin }: LoginProps) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAvatar, setNewAvatar] = useState(AVATARS[0]);
  const [newPin, setNewPin] = useState('');

  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState(false);

  useEffect(() => {
    fetchProfiles();
  }, []);

  const fetchProfiles = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/v1/profiles');
      if (res.ok) {
        const data = await res.json();
        setProfiles(data);
      }
    } catch (e) {
      console.error('Failed to fetch profiles:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    try {
      const res = await fetch('/api/v1/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          avatar_id: newAvatar,
          pin: newPin || null
        })
      });

      if (res.ok) {
        const newProfile = await res.json();
        setProfiles([...profiles, newProfile]);
        setIsCreating(false);
        setNewName('');
        setNewPin('');
      }
    } catch (e) {
      console.error('Failed to create profile', e);
    }
  };

  const handleProfileClick = async (profile: Profile) => {
    if (profile.pin) {
      // Necesita PIN
      setSelectedProfile(profile);
      setPinInput('');
      setPinError(false);
    } else {
      // Entra directo
      loginWithProfile(profile);
    }
  };

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProfile) return;

    try {
      const res = await fetch('/api/v1/profiles/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedProfile.id, pin: pinInput })
      });

      if (res.ok) {
        loginWithProfile(selectedProfile);
      } else {
        setPinError(true);
        setPinInput('');
      }
    } catch (e) {
      console.error('Login failed', e);
      setPinError(true);
    }
  };

  const loginWithProfile = (profile: Profile) => {
    localStorage.setItem('niti_active_profile', JSON.stringify(profile));
    onLogin(profile);
  };

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-void-950 flex flex-col items-center justify-center z-[100]">
        <div className="w-10 h-10 border-4 border-void-800 border-t-amber-400 rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-void-950 text-white flex flex-col items-center justify-center z-[100] animate-in fade-in duration-500">

      <div className="absolute top-8 left-8 sm:left-12">
        <h1 className="text-2xl sm:text-3xl font-display font-black tracking-tight text-white drop-shadow-md">
          NITI<span className="text-amber-400">FLIX</span>
        </h1>
      </div>

      {!isCreating && !selectedProfile && (
        <div className="flex flex-col items-center max-w-4xl w-full px-4">
          <h2 className="text-3xl sm:text-5xl font-display text-white mb-10 text-center font-medium">
            ¿Quién está viendo ahora?
          </h2>

          <div className="flex flex-wrap justify-center gap-4 sm:gap-8 mb-12">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                onClick={() => handleProfileClick(profile)}
                className="group flex flex-col items-center cursor-pointer w-24 sm:w-32"
              >
                <div className={`w-24 h-24 sm:w-32 sm:h-32 rounded-md ${profile.avatar_id} border-2 border-transparent group-hover:border-white transition-all duration-200 shadow-md relative overflow-hidden flex items-center justify-center`}>
                  {/* Si tuvieras imagenes usarías <img />, por ahora son colores sólidos */}
                  {profile.pin && (
                    <div className="absolute bottom-2 right-2 bg-void-950/50 p-1 rounded-full">
                      <Lock size={12} className="text-white" />
                    </div>
                  )}
                </div>
                <span className="mt-4 text-zinc-400 group-hover:text-white font-medium text-sm sm:text-base truncate w-full text-center transition-colors">
                  {profile.name}
                </span>
              </div>
            ))}

            {/* Añadir Perfil */}
            <div
              onClick={() => setIsCreating(true)}
              className="group flex flex-col items-center cursor-pointer w-24 sm:w-32"
            >
              <div className="w-24 h-24 sm:w-32 sm:h-32 rounded-md border-2 border-zinc-600 group-hover:border-white group-hover:bg-zinc-800 transition-all duration-200 flex items-center justify-center">
                <Plus size={48} className="text-zinc-600 group-hover:text-white transition-colors" />
              </div>
              <span className="mt-4 text-zinc-400 group-hover:text-white font-medium text-sm sm:text-base text-center transition-colors">
                Añadir perfil
              </span>
            </div>
          </div>
        </div>
      )}

      {selectedProfile && (
        <div className="flex flex-col items-center max-w-md w-full px-4 animate-in zoom-in-95 duration-200">
          <h2 className="text-2xl sm:text-3xl font-display text-white mb-6 text-center">
            Introduce tu PIN para acceder
          </h2>

          <div className={`w-24 h-24 sm:w-32 sm:h-32 rounded-md ${selectedProfile.avatar_id} mb-4 shadow-md`}></div>
          <span className="text-lg font-medium text-white mb-8">{selectedProfile.name}</span>

          <form onSubmit={handlePinSubmit} className="flex flex-col items-center w-full max-w-xs">
            <input
              type="password"
              maxLength={4}
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="PIN de 4 dígitos"
              className={`w-full bg-void-900 border ${pinError ? 'border-danger text-danger' : 'border-zinc-700 text-white'} rounded-md py-3 px-4 text-center text-xl tracking-widest outline-none focus:border-amber-400 transition-colors mb-4`}
              autoFocus
            />
            {pinError && <p className="text-danger text-sm mb-4">PIN incorrecto. Inténtalo de nuevo.</p>}

            <button
              type="submit"
              className="w-full bg-white text-black font-bold py-3 rounded-md hover:bg-zinc-200 transition-colors"
            >
              Entrar
            </button>
            <button
              type="button"
              onClick={() => { setSelectedProfile(null); setPinInput(''); setPinError(false); }}
              className="mt-4 text-zinc-400 hover:text-white text-sm"
            >
              Cancelar
            </button>
          </form>
        </div>
      )}

      {isCreating && (
        <div className="flex flex-col items-center max-w-2xl w-full px-4 animate-in slide-in-from-bottom-8 duration-300">
          <h2 className="text-3xl font-display text-white mb-2 text-center">Añadir perfil</h2>
          <p className="text-zinc-400 mb-8 text-center text-sm">Añade un perfil para otra persona</p>

          <form onSubmit={handleCreateProfile} className="w-full max-w-md flex flex-col gap-6 bg-void-900/50 p-6 sm:p-8 rounded-xl border border-void-800">

            <div className="flex gap-4 items-center">
               <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-md ${newAvatar} shrink-0`}></div>
               <div className="flex-1">
                 <input
                    type="text"
                    placeholder="Nombre"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="w-full bg-void-800 border-none rounded py-3 px-4 text-white outline-none focus:ring-2 focus:ring-amber-400 text-lg"
                    required
                 />
               </div>
            </div>

            <div>
              <p className="text-sm text-zinc-400 mb-3">Color de Avatar:</p>
              <div className="flex flex-wrap gap-3">
                {AVATARS.map(avatar => (
                  <button
                    key={avatar}
                    type="button"
                    onClick={() => setNewAvatar(avatar)}
                    className={`w-10 h-10 rounded-full ${avatar} ${newAvatar === avatar ? 'ring-2 ring-offset-2 ring-offset-void-950 ring-white' : ''} transition-all`}
                  />
                ))}
              </div>
            </div>

            <div>
              <p className="text-sm text-zinc-400 mb-3">PIN (Opcional):</p>
              <input
                type="password"
                maxLength={4}
                placeholder="4 dígitos numéricos"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/[^0-9]/g, ''))}
                className="w-full bg-void-800 border-none rounded py-3 px-4 text-white outline-none focus:ring-2 focus:ring-amber-400 tracking-widest font-mono"
              />
            </div>

            <div className="flex gap-4 mt-4 pt-4 border-t border-void-800">
              <button
                type="submit"
                disabled={!newName.trim()}
                className="flex-1 bg-white text-black font-bold py-3 rounded hover:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Continuar
              </button>
              <button
                type="button"
                onClick={() => { setIsCreating(false); setNewName(''); setNewPin(''); }}
                className="flex-1 bg-transparent border border-zinc-500 text-zinc-300 font-bold py-3 rounded hover:border-white hover:text-white transition-colors"
              >
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
