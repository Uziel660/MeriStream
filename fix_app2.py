import re

with open("src/App.tsx", "r") as f:
    content = f.read()

# Fix import for Login (it's export function App, not export default function App)
if "import { Login } " not in content:
    content = content.replace("import { useEffect, useState, useMemo } from 'react';",
                              "import { useEffect, useState, useMemo } from 'react';\nimport { Login } from './components/Login';")

# Add activeProfile state if missing
if "const [activeProfile, setActiveProfile]" not in content:
    state_injection = """
  // Perfil activo (Login)
  const [activeProfile, setActiveProfile] = useState<any>(null);

  // Restaurar perfil al cargar
  useEffect(() => {
    const stored = localStorage.getItem('niti_active_profile');
    if (stored) {
      try { setActiveProfile(JSON.parse(stored)); } catch (e) {}
    }
  }, []);
"""
    content = content.replace("export function App() {\n", "export function App() {\n" + state_injection)

# Render Login
if "<Login onLogin" not in content:
    login_render = """
  if (!activeProfile) {
    return <Login onLogin={(profile) => setActiveProfile(profile)} />;
  }
"""
    content = content.replace("return (\n    <div className=", login_render + "\n  return (\n    <div className=")

with open("src/App.tsx", "w") as f:
    f.write(content)
