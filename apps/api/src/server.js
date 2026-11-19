import "dotenv/config";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findUserByEmail, getUserById, listClubsForUser, registerAccount,
  getClubMembership, updateClub, listClubMembers, listClubInvitations,
  createClubInvitation, findInvitation, acceptClubInvitation, registerUser
} from "./db.js";

const isProduction = process.env.NODE_ENV === "production";
const appSecret = process.env.APP_SECRET;
if (isProduction && (!appSecret || appSecret.length < 32)) {
  throw new Error("APP_SECRET must be set to at least 32 characters in production.");
}

export async function buildApp(options = {}) {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 16 * 1024 });
  await app.register(cors, { origin: process.env.WEB_ORIGIN || "http://localhost:5173", credentials: true });
  await app.register(cookie);
  await app.register(jwt, {
    secret: appSecret || "paceup-local-development-secret-change-before-deployment",
    cookie: { cookieName: "paceup_session", signed: false },
    sign: { expiresIn: "7d" }
  });

  app.decorate("authenticate", async function (request, reply) {
    try { await request.jwtVerify(); }
    catch { return reply.code(401).send({ error: "Please sign in to continue." }); }
  });

  function makeSlug(value) {
    return value.normalize("NFKD").toLowerCase()
      .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "").slice(0, 60);
  }
  function setSession(reply, user) {
    reply.setCookie("paceup_session", app.jwt.sign({ sub: user.id }), {
      httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: 604800
    });
  }
  function requireClubRole(roles) {
    return async (request, reply) => {
      const membership = getClubMembership(request.params.clubId, request.user.sub);
      if (!membership || !roles.includes(membership.role)) {
        return reply.code(404).send({ error: "Club not found or you don't have permission to manage it." });
      }
      request.clubMembership = membership;
    };
  }

  app.get("/health", async () => ({ status: "ok", name: "paceup-api" }));

  app.post("/api/auth/register", async (request, reply) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    const clubName = typeof request.body?.clubName === "string" ? request.body.clubName.trim() : "";
    const inviteToken = typeof request.body?.inviteToken === "string" ? request.body.inviteToken : "";
    const slug = makeSlug(clubName);

    if (name.length < 2 || name.length > 80) return reply.code(400).send({ error: "Enter your name (2–80 characters)." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return reply.code(400).send({ error: "Enter a valid email address." });
    if (password.length < 10 || password.length > 128) return reply.code(400).send({ error: "Use a password between 10 and 128 characters." });

    let invitation = null;
    if (inviteToken) {
      if (inviteToken.length > 200) return reply.code(400).send({ error: "This invitation link is invalid." });
      invitation = findInvitation(createHash("sha256").update(inviteToken).digest("hex"));
      if (!invitation || invitation.accepted_at || new Date(invitation.expires_at).getTime() <= Date.now()) {
        return reply.code(410).send({ error: "This invitation has expired or has already been used." });
      }
      if (email.toLowerCase() !== invitation.email.toLowerCase()) {
        return reply.code(403).send({ error: "Register using the email address this invitation was sent to." });
      }
    } else if (clubName.length < 2 || clubName.length > 80 || !slug) {
      return reply.code(400).send({ error: "Enter a valid club name (2–80 characters)." });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const userInput = { id: randomUUID(), name, email, passwordHash };
      const user = invitation
        ? registerUser(userInput)
        : registerAccount({
            user: userInput,
            club: { id: randomUUID(), name: clubName, slug },
            membership: { id: randomUUID() }
          }).user;
      setSession(reply, user);
      return reply.code(201).send({ user, clubs: listClubsForUser(user.id) });
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return reply.code(409).send({ error: "An account with this email already exists. Sign in instead." });
      request.log.error(error);
      return reply.code(500).send({ error: "Could not create your account. Please try again." });
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!email || !password) return reply.code(400).send({ error: "Enter your email and password." });
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

  app.patch("/api/clubs/:clubId", {
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])]
  }, async (request, reply) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const slug = makeSlug(name);
    if (name.length < 2 || name.length > 80 || !slug) return reply.code(400).send({ error: "Club name must be 2–80 characters and contain letters or numbers." });
    try {
      const club = updateClub(request.params.clubId, name, slug);
      return { club };
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return reply.code(409).send({ error: "That club URL is already in use. Choose another name." });
      request.log.error(error);
      return reply.code(500).send({ error: "Could not update the club." });
    }
  });

  app.get("/api/clubs/:clubId/members", {
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])]
  }, async (request) => ({ members: listClubMembers(request.params.clubId) }));

  app.get("/api/clubs/:clubId/invitations", {
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])]
  }, async (request) => ({ invitations: listClubInvitations(request.params.clubId) }));

  app.post("/api/clubs/:clubId/invitations", {
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])]
  }, async (request, reply) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const role = request.body?.role === "member" ? "member" : "admin";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return reply.code(400).send({ error: "Enter a valid email address." });
    const existing = findUserByEmail(email);
    if (existing && getClubMembership(request.params.clubId, existing.id)) return reply.code(409).send({ error: "This person is already a member of the club." });
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    createClubInvitation({
      id: randomUUID(), clubId: request.params.clubId, email, role, tokenHash,
      invitedBy: request.user.sub, expiresAt
    });
    const baseUrl = process.env.APP_BASE_URL || "http://localhost:5173";
    return reply.code(201).send({
      invitation: { email, role, expiresAt, inviteUrl: `${baseUrl}/invite/${token}` },
      note: "Share this link with the invited person. It is shown only once; email delivery is not connected yet."
    });
  });

  app.post("/api/invitations/accept", {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    if (!token || token.length > 200) return reply.code(400).send({ error: "This invitation link is invalid." });
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const invitation = findInvitation(tokenHash);
    if (!invitation || invitation.accepted_at || new Date(invitation.expires_at).getTime() <= Date.now()) {
      return reply.code(410).send({ error: "This invitation has expired or has already been used." });
    }
    const user = getUserById(request.user.sub);
    if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      return reply.code(403).send({ error: "Sign in with the email address this invitation was sent to." });
    }
    if (getClubMembership(invitation.club_id, user.id)) return reply.code(409).send({ error: "You're already a member of this club." });
    acceptClubInvitation(invitation, user.id);
    return { success: true, clubs: listClubsForUser(user.id) };
  });



  return app;
}

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await buildApp();
  try { await app.listen({ port, host }); }
  catch (error) { app.log.error(error); process.exit(1); }
}
