import re

with open("src/App.tsx", "r") as f:
    content = f.read()

# 1. Import Login
if "import { Login } " not in content:
    content = content.replace("import React, { useState, useEffect, useRef } from 'react';",
                              "import React, { useState, useEffect, useRef } from 'react';\nimport { Login } from './components/Login';")

# 2. Add activeProfile state
if "const [activeProfile, setActiveProfile]" not in content:
    state_injection = """
  // Perfil activo (Login)
  const [activeProfile, setActiveProfile] = useState<any>(null);
"""
    content = content.replace("export default function App() {\n", "export default function App() {\n" + state_injection)

# 3. Add useEffect to read localStorage for profile
if "niti_active_profile" not in content:
    effect_injection = """
  useEffect(() => {
    const stored = localStorage.getItem('niti_active_profile');
    if (stored) {
      try { setActiveProfile(JSON.parse(stored)); } catch (e) {}
    }
  }, []);
"""
    content = content.replace("  // Cargar catálogo inicial al montar\n", effect_injection + "\n  // Cargar catálogo inicial al montar\n")

# 4. Wrap the return statement with the Login check
if "<Login onLogin" not in content:
    login_render = """
  if (!activeProfile) {
    return <Login onLogin={(profile) => setActiveProfile(profile)} />;
  }
"""
    content = content.replace("return (\n    <div className=", login_render + "\n  return (\n    <div className=")

with open("src/App.tsx", "w") as f:
    f.write(content)

print("App.tsx modified successfully")
