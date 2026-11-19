import "dotenv/config";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import {
  findUserByEmail,
  getUserById,
  listClubsForUser,
  registerAccount
} from "./db.js";

const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";
const isProduction = process.env.NODE_ENV === "production";
const appSecret = process.env.APP_SECRET;

if (isProduction && (!appSecret || appSecret.length < 32)) {
  throw new Error("APP_SECRET must be set to at least 32 characters in production.");
}

await app.register(cors, {
  origin: process.env.WEB_ORIGIN || "http://localhost:5173",
  credentials: true
});
await app.register(cookie);
await app.register(jwt, {
  secret: appSecret || "paceup-local-development-secret-change-before-deployment",
  cookie: {
    cookieName: "paceup_session",
    signed: false
  },
  sign: { expiresIn: "7d" }
});

app.decorate("authenticate", async function (request, reply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Please sign in to continue." });
  }
});

function makeSlug(value) {
  return value.normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function setSession(reply, user) {
  const token = app.jwt.sign({ sub: user.id });
  reply.setCookie("paceup_session", token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });
}

app.get("/health", async () => ({ status: "ok", name: "paceup-api" }));

app.post("/api/auth/register", async (request, reply) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const clubName = typeof request.body?.clubName === "string" ? request.body.clubName.trim() : "";
  const slug = makeSlug(clubName);

  if (name.length < 2 || name.length > 80) {
    return reply.code(400).send({ error: "Enter your name (2–80 characters)." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return reply.code(400).send({ error: "Enter a valid email address." });
  }
  if (password.length < 10 || password.length > 128) {
    return reply.code(400).send({ error: "Use a password between 10 and 128 characters." });
  }
  if (clubName.length < 2 || clubName.length > 80 || !slug) {
    return reply.code(400).send({ error: "Enter a valid club name (2–80 characters)." });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = registerAccount({
      user: { id: randomUUID(), name, email, passwordHash },
      club: { id: randomUUID(), name: clubName, slug },
      membership: { id: randomUUID() }
    });
    setSession(reply, result.user);
    return reply.code(201).send({ user: result.user, clubs: listClubsForUser(result.user.id) });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return reply.code(409).send({
        error: error.message.includes("users.email")
          ? "An account with this email already exists. Sign in instead."
          : "A club with a similar URL name already exists. Try another club name."
      });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "Could not create your account. Please try again." });
  }
});

app.post("/api/auth/login", async (request, reply) => {
  const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";

  if (!email || !password) {
    return reply.code(400).send({ error: "Enter your email and password." });
  }

  const user = findUserByEmail(email);
  const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!valid) return reply.code(401).send({ error: "Email or password is incorrect." });

  const safeUser = getUserById(user.id);
  setSession(reply, safeUser);
  return { user: safeUser, clubs: listClubsForUser(user.id) };
});

app.post("/api/auth/logout", async (_request, reply) => {
  reply.clearCookie("paceup_session", { path: "/" });
  return { success: true };
});

app.get("/api/auth/me", { preHandler: [app.authenticate] }, async (request, reply) => {
  const user = getUserById(request.user.sub);
  if (!user) {
    reply.clearCookie("paceup_session", { path: "/" });
    return reply.code(401).send({ error: "Please sign in again." });
  }
  return { user, clubs: listClubsForUser(user.id) };
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
