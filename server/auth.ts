import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "./db";

const JWT_SECRET = process.env.JWT_SECRET || "nitiflix-secret-jwt-key-2026";
const authRouter = Router();

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
  };
}

// Middleware de autenticación requerida
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autorizado. Token no proporcionado." });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; username: string };
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado." });
  }
}

// Middleware de autenticación opcional (no falla si no hay token)
export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { id: string; username: string };
      req.user = decoded;
    } catch {
      // Ignorar token inválido en modo opcional
    }
  }
  next();
}

/**
 * POST /api/auth/register
 * Registro simple de usuario
 */
authRouter.post("/register", async (req: Request, res: Response) => {
  try {
    const { username, password, avatar } = req.body;

    if (!username || typeof username !== "string" || username.trim().length < 3) {
      return res.status(400).json({ error: "El nombre de usuario debe tener al menos 3 caracteres." });
    }

    if (!password || typeof password !== "string" || password.length < 4) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres." });
    }

    const cleanUsername = username.trim().toLowerCase();

    // Verificar si ya existe
    const existing = await prisma.user.findUnique({
      where: { username: cleanUsername },
    });

    if (existing) {
      return res.status(409).json({ error: "Ese nombre de usuario ya está registrado." });
    }

    // Hashear contraseña
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const newUser = await prisma.user.create({
      data: {
        username: cleanUsername,
        password_hash,
        avatar: avatar || "amber",
      },
      select: {
        id: true,
        username: true,
        avatar: true,
        created_at: true,
      },
    });

    // Generar token JWT (duración 30 días)
    const token = jwt.sign(
      { id: newUser.id, username: newUser.username },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.status(201).json({
      message: "Usuario creado exitosamente",
      user: newUser,
      token,
    });
  } catch (error: any) {
    console.error("Error en registro:", error);
    return res.status(500).json({ error: "Error al registrar usuario: " + (error?.message || error) });
  }
});

/**
 * POST /api/auth/login
 * Inicio de sesión simple
 */
authRouter.post("/login", async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Usuario y contraseña son requeridos." });
    }

    const cleanUsername = username.trim().toLowerCase();

    const user = await prisma.user.findUnique({
      where: { username: cleanUsername },
    });

    if (!user) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.json({
      message: "Sesión iniciada correctamente",
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        created_at: user.created_at,
      },
      token,
    });
  } catch (error: any) {
    console.error("Error en login:", error);
    return res.status(500).json({ error: "Error al iniciar sesión: " + (error?.message || error) });
  }
});

/**
 * GET /api/auth/me
 * Obtener perfil del usuario actual
 */
authRouter.get("/me", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        username: true,
        avatar: true,
        created_at: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    return res.json({ user });
  } catch (error: any) {
    console.error("Error al obtener usuario:", error);
    return res.status(500).json({ error: "Error al obtener perfil." });
  }
});

/**
 * PATCH /api/auth/avatar
 * Cambiar avatar/color de perfil
 */
authRouter.patch("/avatar", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { avatar } = req.body;
    if (!avatar || typeof avatar !== "string") {
      return res.status(400).json({ error: "Avatar no válido." });
    }

    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: { avatar },
      select: {
        id: true,
        username: true,
        avatar: true,
        created_at: true,
      },
    });

    return res.json({ user: updated });
  } catch (error: any) {
    return res.status(500).json({ error: "Error al actualizar avatar." });
  }
});

export { authRouter };
