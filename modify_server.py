import re

with open("server.ts", "r") as f:
    content = f.read()

# Define the new endpoints
new_endpoints = """
  // ==========================================
  // Rutas de Autenticación de Perfiles (Estilo Netflix)
  // ==========================================

  // GET /api/v1/profiles - Listar todos los perfiles
  app.get("/api/v1/profiles", async (req: Request, res: Response) => {
    try {
      const profiles = await prisma.profile.findMany({
        orderBy: { created_at: "asc" }
      });
      res.json(profiles);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/profiles - Crear un nuevo perfil
  app.post("/api/v1/profiles", async (req: Request, res: Response) => {
    try {
      const { name, avatar_id, pin } = req.body;
      if (!name || !avatar_id) {
        return res.status(400).json({ detail: "name y avatar_id son requeridos" });
      }

      const newProfile = await prisma.profile.create({
        data: { name, avatar_id, pin: pin || null }
      });
      res.json(newProfile);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/profiles/login - Validar PIN de un perfil (Login)
  app.post("/api/v1/profiles/login", async (req: Request, res: Response) => {
    try {
      const { id, pin } = req.body;
      if (!id) {
        return res.status(400).json({ detail: "id de perfil requerido" });
      }

      const profile = await prisma.profile.findUnique({ where: { id } });
      if (!profile) {
        return res.status(404).json({ detail: "Perfil no encontrado" });
      }

      // Si el perfil tiene un PIN y no coincide
      if (profile.pin && profile.pin !== pin) {
        return res.status(401).json({ detail: "PIN incorrecto" });
      }

      // Si no tiene PIN o el PIN coincide, login exitoso
      res.json({ status: "ok", profile });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
"""

# Find the Vite Middleware block and insert the new endpoints right before it
pattern = r"(\s*// ==========================================\s*// Vite Middleware & Static Frontend Serving\s*// ==========================================)"

# check if already added
if "Rutas de Autenticación de Perfiles" not in content:
    modified_content = re.sub(pattern, new_endpoints + r"\1", content)

    with open("server.ts", "w") as f:
        f.write(modified_content)
    print("Endpoints added successfully.")
else:
    print("Endpoints already exist.")
