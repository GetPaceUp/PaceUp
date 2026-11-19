import "dotenv/config";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createClub, listClubs } from "./db.js";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";

await app.register(cors, {
  origin: process.env.WEB_ORIGIN || "http://localhost:5173"
});

app.get("/health", async () => ({
  status: "ok",
  name: "paceup-api"
}));

app.get("/api/clubs", async () => ({
  clubs: listClubs()
}));

app.post("/api/clubs", async (request, reply) => {
  const name = typeof request.body?.name === "string"
    ? request.body.name.trim()
    : "";

  if (name.length < 2 || name.length > 80) {
    return reply.code(400).send({
      error: "Club name must be between 2 and 80 characters."
    });
  }

  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  if (!slug) {
    return reply.code(400).send({ error: "Please enter a valid club name." });
  }

  try {
    const club = createClub({ id: randomUUID(), name, slug });
    return reply.code(201).send({ club });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return reply.code(409).send({
        error: "A club with a similar name already exists. Try a more distinctive name."
      });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "Could not create the club." });
  }
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
