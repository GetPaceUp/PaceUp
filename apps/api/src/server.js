import "dotenv/config";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import bcrypt from "bcryptjs";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { registerRideRoutes } from "./rides.js";
import { registerRosterRoutes } from "./roster.js";
import { registerOtpRoutes } from "./otp.js";
import { registerClubAdminRoutes, checkOwnerLink, useOwnerLink } from "./clubs-admin.js";
import { registerDirectoryRoutes } from "./directory.js";
import { registerTemplateRoutes } from "./templates.js";
import { registerWhatsAppRoutes } from "./whatsapp/routes.js";
import { createPasswordReset, checkPasswordReset, usePasswordReset } from "./password-reset.js";
import {
  findUserByEmail, getUserById, listClubsForUser, registerAccount, createUser,
  getClubMembership, updateClub, listClubMembers, listClubInvitations,
  createClubInvitation, findInvitation, acceptInvitation, registerWithInvitation,
  getPlatformRole, getPlatformOverview, changePlatformRole, listPlatformAudit,
  createSession, getActiveSession, applyOwnerBootstrap, revokeSession, revokeAllSessions, purgeExpiredSessions,
  DomainError
} from "./db.js";

const isProduction = process.env.NODE_ENV === "production";
// The commit this server was started from, so a deploy can be confirmed over HTTPS (/health).
const deployedVersion = (() => {
  try { return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
})();
const appSecret = process.env.APP_SECRET;
if (isProduction && (!appSecret || appSecret.length < 32)) {
  throw new Error("APP_SECRET must be set to at least 32 characters in production.");
}

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 90);
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const hashToken = (token) => createHash("sha256").update(token).digest("hex");

export async function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? {
      level: options.logLevel ?? "info",
      ...(options.logStream ? { stream: options.logStream } : {}),
      // Never write credentials to logs: cookies, auth headers and set-cookie are redacted.
      redact: ["req.headers.cookie", "req.headers.authorization", "res.headers[\"set-cookie\"]"]
    },
    bodyLimit: 16 * 1024,
    // The API listens on 127.0.0.1 behind Caddy, so only a local proxy can set X-Forwarded-For.
    trustProxy: process.env.TRUST_PROXY || "loopback"
  });
  const allowedOrigins = new Set([process.env.WEB_ORIGIN || "http://localhost:5173"]);
  if (process.env.APP_BASE_URL) allowedOrigins.add(new URL(process.env.APP_BASE_URL).origin);

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  await app.register(cors, { origin: [...allowedOrigins], credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({ statusCode: 429, error: "Too many attempts. Please wait a few minutes and try again." })
  });
  await app.register(jwt, {
    secret: appSecret || "paceup-local-development-secret-change-before-deployment",
    cookie: { cookieName: "paceup_session", signed: false },
    sign: { expiresIn: `${SESSION_TTL_DAYS}d` }
  });

  // Cross-site request protection for cookie-authenticated writes. The session
  // cookie is SameSite=Lax, and browsers always send Origin on cross-site POSTs,
  // so any state-changing request from a foreign origin is refused here.
  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host && (host === request.headers.host || allowedOrigins.has(origin))) return;
    return reply.code(403).send({ error: "Request blocked: unexpected origin." });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.validation) {
      if (error.validationContext === "params") return reply.code(404).send({ error: "Not found." });
      return reply.code(400).send({ error: "Some details are missing or invalid." });
    }
    const status = error.statusCode || 500;
    if (status >= 500) request.log.error(error);
    return reply.code(status).send({ error: status >= 500 ? "Something went wrong. Please try again." : (error.error || error.message) });
  });

  purgeExpiredSessions();
  const purgeTimer = setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000);
  purgeTimer.unref();
  app.addHook("onClose", async () => clearInterval(purgeTimer));

  app.decorate("authenticate", async function (request, reply) {
    try {
      await request.jwtVerify();
      if (!request.user.sid || !getActiveSession(request.user.sid, request.user.sub)) throw new Error("session ended");
    } catch {
      reply.clearCookie("paceup_session", { path: "/" });
      return reply.code(401).send({ error: "Please sign in to continue." });
    }
  });

  const id = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" };
  const str = (maxLength) => ({ type: "string", maxLength });
  const authLimit = (max) => ({ rateLimit: { max: options.authRateLimit ?? max, timeWindow: "15 minutes" } });

  function makeSlug(value) {
    return value.normalize("NFKD").toLowerCase()
      .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "").slice(0, 60);
  }
  function setSession(reply, user) {
    applyOwnerBootstrap(user.email);
    const session = createSession(user.id, SESSION_TTL_MS);
    reply.setCookie("paceup_session", app.jwt.sign({ sub: user.id, sid: session.id }), {
      httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS / 1000
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

  /** Identifies the signed-in user when there is one, without requiring it. */
  async function optionalUser(request) {
    request.userId = null;
    try {
      await request.jwtVerify();
      if (request.user.sid && getActiveSession(request.user.sid, request.user.sub)) request.userId = request.user.sub;
    } catch { /* visitor */ }
  }

  app.get("/health", async () => ({ status: "ok", name: "paceup-api", version: deployedVersion }));
  registerRideRoutes(app, { requireClubRole, optionalUser, isProduction, publicRateLimit: options.publicRateLimit ?? 30 });
  registerRosterRoutes(app, { requireClubRole });
  registerTemplateRoutes(app, { requireClubRole });
  registerOtpRoutes(app, { setSession, makeSlug, hashToken, limit: authLimit });
  registerWhatsAppRoutes(app, { requireClubRole, requirePlatformAdmin, rateLimit: options.authRateLimit });

  // ---- password reset (one-time links shared by an admin; no email needed)
  const sendDomain = (reply, error) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message });
    throw error;
  };
  const userParam = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" };
  app.post("/api/clubs/:clubId/members/:userId/password-reset", {
    schema: { params: { type: "object", properties: { clubId: userParam, userId: userParam }, required: ["clubId", "userId"] } },
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])]
  }, async (request, reply) => {
    try { return reply.code(201).send(createPasswordReset({ actorId: request.user.sub, targetId: request.params.userId, clubId: request.params.clubId, ip: request.ip })); }
    catch (error) { return sendDomain(reply, error); }
  });
  app.post("/api/platform/users/:userId/password-reset", {
    schema: { params: { type: "object", properties: { userId: userParam }, required: ["userId"] } },
    preHandler: [app.authenticate, requirePlatformAdmin]
  }, async (request, reply) => {
    try { return reply.code(201).send(createPasswordReset({ actorId: request.user.sub, targetId: request.params.userId, ip: request.ip })); }
    catch (error) { return sendDomain(reply, error); }
  });
  const tokenSchema = { type: "string", minLength: 20, maxLength: 200 };
  // POST with the token in the body, so a live reset token never lands in request logs.
  app.post("/api/password-reset/check", {
    config: authLimit(30), schema: { body: { type: "object", properties: { token: tokenSchema }, required: ["token"] } }
  }, async (request, reply) => {
    try { return checkPasswordReset(request.body.token); } catch (error) { return sendDomain(reply, error); }
  });
  app.post("/api/password-reset", {
    config: authLimit(10),
    schema: { body: { type: "object", properties: { token: tokenSchema, password: { type: "string", maxLength: 128 } }, required: ["token", "password"] } }
  }, async (request, reply) => {
    try {
      const user = await usePasswordReset(request.body.token, request.body.password, request.ip);
      setSession(reply, user);
      return { user: { ...user, super_admin: getPlatformRole(user.id) === "super_admin" }, clubs: listClubsForUser(user.id) };
    } catch (error) { return sendDomain(reply, error); }
  });

  async function requirePlatformAdmin(request, reply) {
    if (getPlatformRole(request.user.sub) !== "super_admin") return reply.code(403).send({ error: "Platform owner access required." });
  }
  app.get("/api/platform/overview", { preHandler: [app.authenticate, requirePlatformAdmin] }, async () => ({
    ...getPlatformOverview(),
    services: { api: "online", whatsapp: "not_configured", ssl: "managed_by_deployment" }
  }));
  registerClubAdminRoutes(app, { requireClubRole, requirePlatformAdmin });
  registerDirectoryRoutes(app, { requirePlatformAdmin });

  // ---- a new club's owner signs in once with the link the Super Admin shared (the club has no number yet)
  const ownerToken = { type: "string", minLength: 20, maxLength: 100 };
  app.post("/api/start/check", { config: authLimit(30), schema: { body: { type: "object", properties: { token: ownerToken }, required: ["token"] } } }, async (request, reply) => {
    try { return checkOwnerLink(request.body.token); } catch (error) { return sendDomain(reply, error); }
  });
  app.post("/api/start", {
    config: authLimit(10), schema: { body: { type: "object", properties: { token: ownerToken, last4: { type: "string", maxLength: 8 } }, required: ["token", "last4"] } }
  }, async (request, reply) => {
    try {
      const { user, clubId } = useOwnerLink(request.body.token, request.body.last4);
      setSession(reply, user);
      return { user: { ...user, super_admin: getPlatformRole(user.id) === "super_admin" }, clubs: listClubsForUser(user.id), club_id: clubId };
    } catch (error) { return sendDomain(reply, error); }
  });
  app.get("/api/platform/audit", { preHandler: [app.authenticate, requirePlatformAdmin] }, async () => ({ entries: listPlatformAudit(100) }));
  app.patch("/api/platform/users/:userId/role", {
    preHandler: [app.authenticate, requirePlatformAdmin],
    schema: { params: { type: "object", properties: { userId: id }, required: ["userId"] },
      body: { type: "object", properties: { role: { type: "string", enum: ["user", "super_admin"] } }, required: ["role"] } }
  }, async (request, reply) => {
    const { role } = request.body;
    if (request.params.userId === request.user.sub && role !== "super_admin") return reply.code(400).send({ error: "You cannot remove your own platform-owner access." });
    try {
      return { user: changePlatformRole({ actorUserId: request.user.sub, targetUserId: request.params.userId, role, ip: request.ip }) };
    } catch (error) {
      if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });

  app.post("/api/auth/register", {
    config: authLimit(10),
    schema: { body: { type: "object", properties: { name: str(200), email: str(254), password: str(128), clubName: str(200), inviteToken: str(200) }, required: ["name", "email", "password"] } }
  }, async (request, reply) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    const inviteToken = typeof request.body?.inviteToken === "string" ? request.body.inviteToken : "";

    if (name.length < 2 || name.length > 80) return reply.code(400).send({ error: "Enter your name (2–80 characters)." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return reply.code(400).send({ error: "Enter a valid email address." });
    if (password.length < 10 || password.length > 128) return reply.code(400).send({ error: "Use a password between 10 and 128 characters." });

    let invitation = null;
    if (inviteToken) {
      invitation = findInvitation(hashToken(inviteToken));
      if (!invitation || invitation.accepted_at || new Date(invitation.expires_at).getTime() <= Date.now()) {
        return reply.code(410).send({ error: "This invitation has expired or has already been used." });
      }
      if (invitation.email && email.toLowerCase() !== invitation.email.toLowerCase()) {
        return reply.code(403).send({ error: "Register using the email address this invitation was sent to." });
      }
    }

    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const userInput = { id: randomUUID(), name, email, passwordHash };
      // Clubs are created by the platform owner only; a sign-up without an invitation is just an account.
      const user = invitation ? registerWithInvitation(hashToken(inviteToken), userInput) : createUser(userInput);
      setSession(reply, user);
      return reply.code(201).send({ user, clubs: listClubsForUser(user.id) });
    } catch (error) {
      if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message });
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return reply.code(409).send({ error: "An account with this email already exists. Sign in instead." });
      request.log.error(error);
      return reply.code(500).send({ error: "Could not create your account. Please try again." });
    }
  });

  app.post("/api/auth/login", {
    config: authLimit(20),
    schema: { body: { type: "object", properties: { email: str(254), password: str(128) } } }
  }, async (request, reply) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!email || !password) return reply.code(400).send({ error: "Enter your email and password." });
    const user = findUserByEmail(email);
    // Phone-only accounts have no password ("!"): they sign in with a WhatsApp code.
    const valid = user && user.password_hash !== "!" ? await bcrypt.compare(password, user.password_hash) : false;
    // A password reset may have landed while bcrypt ran: only the current password signs in.
    if (!valid || findUserByEmail(email)?.password_hash !== user.password_hash) return reply.code(401).send({ error: "Email or password is incorrect." });
    const safeUser = getUserById(user.id);
    setSession(reply, safeUser);
    return { user: safeUser, clubs: listClubsForUser(user.id) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    try { await request.jwtVerify(); if (request.user.sid) revokeSession(request.user.sid); } catch { /* already signed out */ }
    reply.clearCookie("paceup_session", { path: "/" });
    return { success: true };
  });

  app.post("/api/auth/logout-all", { preHandler: [app.authenticate] }, async (request, reply) => {
    const ended = revokeAllSessions(request.user.sub);
    reply.clearCookie("paceup_session", { path: "/" });
    return { success: true, sessionsEnded: ended };
  });

  app.get("/api/auth/me", { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = getUserById(request.user.sub);
    if (!user) {
      reply.clearCookie("paceup_session", { path: "/" });
      return reply.code(401).send({ error: "Please sign in again." });
    }
    return { user: { ...user, super_admin: getPlatformRole(user.id) === "super_admin" }, clubs: listClubsForUser(user.id) };
  });

  app.patch("/api/clubs/:clubId", {
    schema: { params: { type: "object", properties: { clubId: id }, required: ["clubId"] },
      body: { type: "object", properties: { name: str(200) }, required: ["name"] } },
    // Only the Super Admin renames a club (it ties to the directory and the club's links); club admins can't.
    preHandler: [app.authenticate, requirePlatformAdmin]
  }, async (request, reply) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const slug = makeSlug(name);
    if (name.length < 2 || name.length > 80 || !slug) return reply.code(400).send({ error: "Club name must be 2–80 characters and contain letters or numbers." });
    try {
      const club = updateClub(request.params.clubId, name, slug);
      if (!club) return reply.code(404).send({ error: "Club not found." });
      return { club };
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return reply.code(409).send({ error: "That club URL is already in use. Choose another name." });
      request.log.error(error);
      return reply.code(500).send({ error: "Could not update the club." });
    }
  });

  app.get("/api/clubs/:clubId/members", {
    schema: { params: { type: "object", properties: { clubId: id }, required: ["clubId"] } },
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])]
  }, async (request) => ({ members: listClubMembers(request.params.clubId) }));

  app.get("/api/clubs/:clubId/invitations", {
    schema: { params: { type: "object", properties: { clubId: id }, required: ["clubId"] } },
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])]
  }, async (request) => ({ invitations: listClubInvitations(request.params.clubId) }));

  app.post("/api/clubs/:clubId/invitations", {
    schema: { params: { type: "object", properties: { clubId: id }, required: ["clubId"] },
      body: { type: "object", properties: { email: str(254), role: { type: "string", enum: ["admin", "member"], default: "member" } } } },
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])]
  }, async (request, reply) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const role = request.body.role;
    // Email is optional: an invite link without one can be used by whoever receives it (e.g. on WhatsApp).
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) return reply.code(400).send({ error: "Enter a valid email address, or leave it empty." });
    const existing = email ? findUserByEmail(email) : null;
    if (existing && getClubMembership(request.params.clubId, existing.id)) return reply.code(409).send({ error: "This person is already a member of the club." });
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
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
    schema: { body: { type: "object", properties: { token: { type: "string", minLength: 1, maxLength: 200 } }, required: ["token"] } },
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    try {
      acceptInvitation(hashToken(request.body.token), request.user.sub);
    } catch (error) {
      if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
    return { success: true, clubs: listClubsForUser(request.user.sub) };
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
