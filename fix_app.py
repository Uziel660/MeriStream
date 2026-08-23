import re

with open("src/App.tsx", "r") as f:
    content = f.read()

if "niti_active_profile" not in content:
    print("Fixing active profile logic...")
    # Add activeProfile state if missing
    if "const [activeProfile, setActiveProfile]" not in content:
        state_injection = """
  // Perfil activo (Login)
  const [activeProfile, setActiveProfile] = useState<any>(null);
"""
        content = content.replace("export default function App() {\n", "export default function App() {\n" + state_injection)

    # Add useEffect for restoring session
    effect_injection = """
  useEffect(() => {
    const stored = localStorage.getItem('niti_active_profile');
    if (stored) {
      try { setActiveProfile(JSON.parse(stored)); } catch (e) {}
    }
  }, []);
"""
    # Insert it right after the component declaration
    content = content.replace("export default function App() {\n", "export default function App() {\n" + effect_injection)

with open("src/App.tsx", "w") as f:
    f.write(content)
