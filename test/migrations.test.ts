/**
 * Reproduces the startup crash that took the app down.
 *
 * `user_sources` has a foreign key on userId. The plugin stores the shared
 * Cloudflare clearance under a sentinel owner that is not a user, and a
 * credential row for a deleted user is just as possible. auto-enabling Royal
 * Road used to blindly INSERT every userId it found, so one such row made the
 * migration throw — and an uncaught migration error stops Tome from booting.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";

const DB = "./data/test-rr-migrations.db";

mkdirSync("./data", { recursive: true });
try { rmSync(DB); } catch {}

const db = new Database(DB);
db.run(`PRAGMA foreign_keys = ON`);
db.run(`CREATE TABLE "user" (id TEXT PRIMARY KEY, username TEXT, role TEXT, createdAt INTEGER)`);
db.run(`
  CREATE TABLE "user_sources" (
    userId TEXT NOT NULL,
    source TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    PRIMARY KEY (userId, source),
    FOREIGN KEY (userId) REFERENCES "user" (id) ON DELETE CASCADE
  )
`);
db.run(`
  CREATE TABLE "user_source_credentials" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL,
    value TEXT NOT NULL, updatedAt INTEGER
  )
`);

afterAll(() => {
  try { db.close(); } catch {}
  try { rmSync(DB); } catch {}
  try { rmSync("./data/test-rr-migrations.db-journal"); } catch {}
});

/** A credential row owned by something that is not a user — e.g. a leftover sentinel owner, or a user who has been deleted. */
const ORPHAN_OWNER = "__shared__";

function seed(): void {
  // user_sources cascades from user; clear children first anyway.
  db.run(`DELETE FROM "user_sources"`);
  db.run(`DELETE FROM "user_source_credentials"`);
  db.run(`DELETE FROM "user"`);

  db.run(`INSERT INTO "user" (id, username, role, createdAt) VALUES ('real-user', 'me', 'admin', 1)`);
  db.run(`INSERT INTO "user" (id, username, role, createdAt) VALUES ('other-user', 'you', 'user', 2)`);

  db.run(`INSERT INTO "user_source_credentials" (userId, source, name, value, updatedAt)
          VALUES ('real-user', 'royalroad', '.AspNetCore.Identity.Application', 'IDENT', 1)`);
  // The crash trigger: a credential row owned by something that is not a user.
  db.run(`INSERT INTO "user_source_credentials" (userId, source, name, value, updatedAt)
          VALUES ('${ORPHAN_OWNER}', 'royalroad', 'cf_clearance', 'CLEARANCE', 1)`);
}

describe("royalroad migrations", () => {
  test("the un-fixed query violates the foreign key", () => {
    seed();
    // The query the plugin used before the fix: every distinct userId, no join.
    const all = db.query(`
      SELECT DISTINCT userId FROM "user_source_credentials" WHERE source = 'royalroad'
    `).all() as { userId: string }[];

    expect(all.map((r) => r.userId).sort()).toEqual([ORPHAN_OWNER, "real-user"]);

    let threw: unknown = null;
    try {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO "user_sources" ("userId", "source", "enabled") VALUES (?, 'royalroad', 1)
      `);
      for (const { userId } of all) stmt.run(userId);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeTruthy();
    expect(String(threw)).toContain("FOREIGN KEY");
  });

  test("migrateRoyalRoad enables real users without throwing", async () => {
    seed();
    const { migrateRoyalRoad } = await import("../src/migrations");
    expect(() => migrateRoyalRoad(db)).not.toThrow();

    const rows = db.query(`SELECT userId FROM "user_sources" WHERE source = 'royalroad'`).all() as {
      userId: string;
    }[];
    expect(rows.map((r) => r.userId).sort()).toEqual(["real-user"]);
  });

  test("migrateRoyalRoad survives a totally broken credentials table", async () => {
    seed();
    const { migrateRoyalRoad } = await import("../src/migrations");
    // Even if something deeper goes wrong, the boot must continue.
    const original = db.query.bind(db);
    (db as any).query = () => {
      throw new Error("simulated database failure");
    };
    try {
      expect(() => migrateRoyalRoad(db)).not.toThrow();
    } finally {
      (db as any).query = original;
    }
  });
});
