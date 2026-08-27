import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../server/db";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "nitiflix-secret-jwt-key-2026";

describe("Auth, Progress and Recommendations System", () => {
  const testUsername = `testuser_${Date.now()}`;
  const testPassword = "testpassword123";
  let userId: string;
  let authToken: string;

  beforeAll(async () => {
    // Limpiar usuario si ya existiera
    await prisma.user.deleteMany({ where: { username: testUsername } });
  });

  afterAll(async () => {
    // Limpiar datos de prueba
    if (userId) {
      await prisma.watchProgress.deleteMany({ where: { user_id: userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("permite registrar un nuevo usuario con contraseña hasheada", async () => {
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(testPassword, salt);

    const newUser = await prisma.user.create({
      data: {
        username: testUsername,
        password_hash,
        avatar: "emerald",
      },
    });

    expect(newUser.id).toBeDefined();
    expect(newUser.username).toBe(testUsername);
    expect(newUser.avatar).toBe("emerald");
    userId = newUser.id;

    authToken = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET);
    expect(authToken).toBeDefined();
  });

  it("verifica contraseñas con bcrypt correctamente", async () => {
    const user = await prisma.user.findUnique({ where: { username: testUsername } });
    expect(user).not.toBeNull();

    const isCorrect = await bcrypt.compare(testPassword, user!.password_hash);
    expect(isCorrect).toBe(true);

    const isWrong = await bcrypt.compare("wrongpass", user!.password_hash);
    expect(isWrong).toBe(false);
  });

  it("permite guardar y recuperar el progreso de reproducción para el usuario", async () => {
    const testShowId = `show_${Date.now()}`;
    const testEpisodeId = `ep_${Date.now()}`;

    const progress = await prisma.watchProgress.upsert({
      where: {
        user_id_show_id_episode_id: {
          user_id: userId,
          show_id: testShowId,
          episode_id: testEpisodeId,
        },
      },
      update: {
        show_title: "Kimetsu no Yaiba",
        episode_number: 1,
        episode_title: "Crueldad",
        progress_percent: 65,
        current_time: 780,
        duration: 1200,
      },
      create: {
        user_id: userId,
        show_id: testShowId,
        show_title: "Kimetsu no Yaiba",
        episode_id: testEpisodeId,
        episode_number: 1,
        episode_title: "Crueldad",
        progress_percent: 65,
        current_time: 780,
        duration: 1200,
      },
    });

    expect(progress.id).toBeDefined();
    expect(progress.progress_percent).toBe(65);

    const userHistory = await prisma.watchProgress.findMany({
      where: { user_id: userId },
      orderBy: { last_watched_at: "desc" },
    });

    expect(userHistory.length).toBeGreaterThan(0);
    expect(userHistory[0].show_title).toBe("Kimetsu no Yaiba");
    expect(userHistory[0].current_time).toBe(780);
  });

  it("permite eliminar un episodio del progreso de reproducción", async () => {
    const testEpisodeId = `ep_to_delete_${Date.now()}`;
    await prisma.watchProgress.create({
      data: {
        user_id: userId,
        show_id: "show_dummy",
        show_title: "Test Show",
        episode_id: testEpisodeId,
        episode_number: 2,
        episode_title: "Episodio 2",
        progress_percent: 20,
      },
    });

    await prisma.watchProgress.deleteMany({
      where: {
        user_id: userId,
        episode_id: testEpisodeId,
      },
    });

    const check = await prisma.watchProgress.findFirst({
      where: { user_id: userId, episode_id: testEpisodeId },
    });
    expect(check).toBeNull();
  });
});
