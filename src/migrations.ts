/**
 * Royal Road migrations — moved from core's lib/migrate.ts.
 * Legacy global-cookie migration + auto-enable for users with credentials.
 */
import type { Database } from "bun:sqlite";
import { AUTH_USERNAME } from "tome";

export function migrateRoyalRoad(db: Database): void {
  migrateGlobalCookiesToAdmin(db);
  autoEnableRoyalRoadForExistingUsers(db);
}

/**
 * Migrate cookies from the old global `cookies` table to the admin user's credentials
 * This runs once when upgrading to multi-user support
 */
/**
 * Find the user the legacy global cookies belong to.
 *
 * Primary key is AUTH_USERNAME, but auth is optional in Tome — when it is
 * disabled that variable is empty and the migration used to silently do
 * nothing, orphaning the old cookies. Fall back to the admin-role user, then to
 * the oldest account, so the migration always has a target.
 */
function findMigrationTarget(db: Database): { id: string } | null {
  if (AUTH_USERNAME) {
    const byUsername = db
      .query(`SELECT id FROM "user" WHERE username = ?`)
      .get(AUTH_USERNAME) as { id: string } | null;
    if (byUsername) return byUsername;
  }

  const byRole = db
    .query(`SELECT id FROM "user" WHERE role = 'admin' ORDER BY createdAt ASC LIMIT 1`)
    .get() as { id: string } | null;
  if (byRole) return byRole;

  return db
    .query(`SELECT id FROM "user" ORDER BY createdAt ASC LIMIT 1`)
    .get() as { id: string } | null;
}

function migrateGlobalCookiesToAdmin(db: Database): void {
  // Check if old cookies table exists
  const tablesResult = db.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='cookies'`
  ).get();

  if (!tablesResult) {
    return; // No old cookies table, nothing to migrate
  }

  // Find admin user by username
  const adminUser = findMigrationTarget(db);

  if (!adminUser) {
    console.log("No admin user found yet, skipping cookie migration");
    return;
  }

  // Check if already migrated (admin has credentials)
  const existingCreds = db.query(
    `SELECT 1 FROM "user_source_credentials" WHERE userId = ? AND source = 'royalroad' LIMIT 1`
  ).get(adminUser.id);

  if (existingCreds) {
    return; // Already migrated
  }

  // Get all cookies from old table
  const oldCookies = db.query(
    `SELECT name, value FROM cookies`
  ).all() as { name: string; value: string }[];

  if (oldCookies.length === 0) {
    return; // No cookies to migrate
  }

  console.log(`Migrating ${oldCookies.length} global cookies to admin user...`);

  // Insert into user_source_credentials
  const insertStmt = db.prepare(`
    INSERT INTO "user_source_credentials" ("userId", "source", "name", "value", "updatedAt")
    VALUES (?, 'royalroad', ?, ?, unixepoch())
  `);

  for (const cookie of oldCookies) {
    insertStmt.run(adminUser.id, cookie.name, cookie.value);
  }

  // Update admin user role to 'admin' if not already set
  db.run(`UPDATE "user" SET role = 'admin' WHERE id = ? AND (role IS NULL OR role = 'user')`, [adminUser.id]);

  console.log(`Successfully migrated cookies to admin user (${adminUser.id})`);
}

function autoEnableRoyalRoadForExistingUsers(db: Database): void {
  const usersWithCredentials = db.query(`
    SELECT DISTINCT userId FROM "user_source_credentials" WHERE source = 'royalroad'
  `).all() as { userId: string }[];

  if (usersWithCredentials.length === 0) {
    return;
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO "user_sources" ("userId", "source", "enabled")
    VALUES (?, 'royalroad', 1)
  `);

  for (const { userId } of usersWithCredentials) {
    insertStmt.run(userId);
  }
}
