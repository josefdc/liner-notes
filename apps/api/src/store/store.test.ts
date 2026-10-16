import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";
import { SqliteStore } from "./store.js";

describe("SqliteStore search", () => {
  let db: Database.Database;
  let store: SqliteStore;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    store = new SqliteStore(db);
  });
  afterEach(() => db.close());

  const namespaces = async (prefix: string[]) =>
    (await store.search(prefix)).map((item) => JSON.stringify(item.namespace)).sort();

  it("matches namespace prefixes exactly: no wildcards, case-sensitive", async () => {
    await store.put(["axb"], "k", { v: 1 });
    await store.put(["a%b"], "k", { v: 2 });
    await store.put(["Mixed"], "k", { v: 3 });
    await store.put(["tracksX"], "k", { v: 4 });

    expect(await namespaces(["a_b"])).toEqual([]);
    expect(await namespaces(["a%b"])).toEqual(['["a%b"]']);
    expect(await namespaces(["a%"])).toEqual([]);
    expect(await namespaces(["mixed"])).toEqual([]);
    expect(await namespaces(["Mixed"])).toEqual(['["Mixed"]']);
    expect(await namespaces(["tracks"])).toEqual([]);
  });

  it("matches nested namespaces exactly too", async () => {
    await store.put(["axb", "c"], "k", { v: 1 });
    await store.put(["Mixed", "c"], "k", { v: 2 });
    await store.put(["a%b", "c"], "k", { v: 3 });

    expect(await namespaces(["a_b"])).toEqual([]);
    expect(await namespaces(["mixed"])).toEqual([]);
    expect(await namespaces(["a%"])).toEqual([]);
    expect(await namespaces(["a%b"])).toEqual(['["a%b","c"]']);
    expect(await namespaces(["Mixed"])).toEqual(['["Mixed","c"]']);
  });

  it("includes namespaces below the prefix", async () => {
    await store.put(["p"], "k", { v: 1 });
    await store.put(["p", "child"], "k", { v: 2 });
    await store.put(["p", "child", "leaf"], "k", { v: 3 });
    await store.put(["pq"], "k", { v: 4 });

    expect(await namespaces(["p"])).toEqual(
      ['["p"]', '["p","child"]', '["p","child","leaf"]'].sort(),
    );
    expect(await namespaces(["p", "child"])).toEqual(
      ['["p","child"]', '["p","child","leaf"]'].sort(),
    );
    expect(await namespaces([])).toHaveLength(4);
  });

  it("applies the filter before the limit and offset", async () => {
    for (let i = 0; i < 12; i++) {
      await store.put(["f"], `n${String(i).padStart(2, "0")}`, { want: i >= 9 });
    }
    const wanted = await store.search(["f"], { filter: { want: true } });
    expect(wanted.map((item) => item.key)).toEqual(["n09", "n10", "n11"]);

    const page = await store.search(["f"], { filter: { want: true }, limit: 1, offset: 1 });
    expect(page.map((item) => item.key)).toEqual(["n10"]);

    expect(await store.search(["f"])).toHaveLength(10);
    expect(await store.search(["f"], { limit: 5, offset: 10 })).toHaveLength(2);
  });

  it("rejects a write that fails instead of swallowing it", async () => {
    db.exec("DROP TABLE store_items");
    db.exec(
      "CREATE TABLE store_items (namespace TEXT, key TEXT, value TEXT NOT NULL, created_at TEXT, updated_at TEXT, CHECK (0))",
    );
    await expect(store.put(["tracks"], "k", { v: 1 })).rejects.toThrow();
  });
});
