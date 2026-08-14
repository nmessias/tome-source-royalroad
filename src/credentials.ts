import { Database } from "bun:sqlite";
import { DB_PATH } from "tome";

const db = new Database(DB_PATH);

export type SourceType = "royalroad" | "patreon" | "webnovel" | "ao3" | "ffnet" | "epub";

export interface Credential {
  id: number;
  userId: string;
  source: SourceType;
  name: string;
  value: string;
  updatedAt: number;
}

export function getUserCredentials(userId: string, source: SourceType): Credential[] {
  return db.query(
    `SELECT * FROM user_source_credentials WHERE userId = ? AND source = ?`
  ).all(userId, source) as Credential[];
}

export function getUserCredential(userId: string, source: SourceType, name: string): Credential | null {
  return db.query(
    `SELECT * FROM user_source_credentials WHERE userId = ? AND source = ? AND name = ?`
  ).get(userId, source, name) as Credential | null;
}

export function setUserCredential(userId: string, source: SourceType, name: string, value: string): void {
  db.run(
    `INSERT INTO user_source_credentials (userId, source, name, value, updatedAt)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(userId, source, name) DO UPDATE SET value = ?, updatedAt = unixepoch()`,
    [userId, source, name, value, value]
  );
}

export function deleteUserCredential(userId: string, source: SourceType, name: string): void {
  db.run(
    `DELETE FROM user_source_credentials WHERE userId = ? AND source = ? AND name = ?`,
    [userId, source, name]
  );
}

export function clearUserCredentials(userId: string, source: SourceType): void {
  db.run(
    `DELETE FROM user_source_credentials WHERE userId = ? AND source = ?`,
    [userId, source]
  );
}

export function hasUserCredentials(userId: string, source: SourceType): boolean {
  const result = db.query(
    `SELECT 1 FROM user_source_credentials WHERE userId = ? AND source = ? LIMIT 1`
  ).get(userId, source);
  return !!result;
}

export function getAllUserCredentials(userId: string): Credential[] {
  return db.query(
    `SELECT * FROM user_source_credentials WHERE userId = ?`
  ).all(userId) as Credential[];
}
