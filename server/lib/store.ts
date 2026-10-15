/**
 * SqliteStore — Persistent LangGraph BaseStore backed by better-sqlite3
 *
 * Drop-in replacement for InMemoryStore. Implements only the abstract
 * `batch()` method; all convenience methods (get, put, search, delete,
 * listNamespaces) are inherited from BaseStore and delegate to batch().
 */

import type Database from "better-sqlite3";
import { BaseStore } from "@langchain/langgraph-checkpoint";
import type {
  Item,
  SearchItem,
  Operation,
  OperationResults,
  GetOperation,
  PutOperation,
  SearchOperation,
  ListNamespacesOperation,
  MatchCondition,
} from "@langchain/langgraph-checkpoint";

// =============================================================================
// Type Guards
// =============================================================================

function isGetOp(op: Operation): op is GetOperation {
  return "namespace" in op && "key" in op && !("value" in op) && !("namespacePrefix" in op);
}

function isPutOp(op: Operation): op is PutOperation {
  return "namespace" in op && "key" in op && "value" in op;
}

function isSearchOp(op: Operation): op is SearchOperation {
  return "namespacePrefix" in op;
}

function isListNamespacesOp(op: Operation): op is ListNamespacesOperation {
  return "matchConditions" in op || ("limit" in op && !("key" in op) && !("namespacePrefix" in op));
}

// =============================================================================
// SqliteStore
// =============================================================================

export class SqliteStore extends BaseStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    super();
    this.db = db;
  }

  async batch<Op extends readonly Operation[]>(
    operations: Op
  ): Promise<OperationResults<Op>> {
    const results: unknown[] = [];

    for (const op of operations) {
      try {
        if (isGetOp(op)) {
          results.push(this.handleGet(op));
        } else if (isPutOp(op)) {
          this.handlePut(op);
          results.push(undefined);
        } else if (isSearchOp(op)) {
          results.push(this.handleSearch(op));
        } else if (isListNamespacesOp(op)) {
          results.push(this.handleListNamespaces(op));
        } else {
          results.push(null);
        }
      } catch (err) {
        console.error("[SqliteStore] Operation error:", err);
        // Graceful fallback: return null/empty for reads, undefined for writes
        if (isPutOp(op)) {
          results.push(undefined);
        } else if (isSearchOp(op) || isListNamespacesOp(op)) {
          results.push([]);
        } else {
          results.push(null);
        }
      }
    }

    return results as OperationResults<Op>;
  }

  // ---------------------------------------------------------------------------
  // Operation Handlers
  // ---------------------------------------------------------------------------

  private handleGet(op: GetOperation): Item | null {
    const nsKey = JSON.stringify(op.namespace);
    const row = this.db
      .prepare("SELECT value, created_at, updated_at FROM store_items WHERE namespace = ? AND key = ?")
      .get(nsKey, op.key) as { value: string; created_at: string; updated_at: string } | undefined;

    if (!row) return null;

    return {
      value: JSON.parse(row.value),
      key: op.key,
      namespace: op.namespace,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private handlePut(op: PutOperation): void {
    if (op.value === null) {
      // Delete
      const nsKey = JSON.stringify(op.namespace);
      this.db
        .prepare("DELETE FROM store_items WHERE namespace = ? AND key = ?")
        .run(nsKey, op.key);
    } else {
      // Upsert
      const nsKey = JSON.stringify(op.namespace);
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO store_items (namespace, key, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`
        )
        .run(nsKey, op.key, JSON.stringify(op.value), now, now);
    }
  }

  private handleSearch(op: SearchOperation): SearchItem[] {
    const nsPrefix = JSON.stringify(op.namespacePrefix);
    // Match rows whose namespace starts with the prefix array
    // We use a LIKE pattern on the JSON-encoded namespace
    // e.g., '["tracks"]' matches '["tracks"]' and '["tracks","sub"]'
    const likePattern = nsPrefix.slice(0, -1) + "%";

    let rows: Array<{ namespace: string; key: string; value: string; created_at: string; updated_at: string }>;

    if (op.namespacePrefix.length === 0) {
      // Empty prefix matches everything
      rows = this.db
        .prepare(
          "SELECT namespace, key, value, created_at, updated_at FROM store_items LIMIT ? OFFSET ?"
        )
        .all(op.limit ?? 10, op.offset ?? 0) as typeof rows;
    } else {
      rows = this.db
        .prepare(
          `SELECT namespace, key, value, created_at, updated_at FROM store_items
           WHERE namespace = ? OR namespace LIKE ?
           LIMIT ? OFFSET ?`
        )
        .all(nsPrefix, likePattern.replace("]", ",%" ), op.limit ?? 10, op.offset ?? 0) as typeof rows;
    }

    // Apply in-memory filter if specified
    let items: SearchItem[] = rows.map((row) => ({
      value: JSON.parse(row.value),
      key: row.key,
      namespace: JSON.parse(row.namespace),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));

    if (op.filter) {
      items = items.filter((item) => matchesFilter(item.value, op.filter!));
    }

    return items;
  }

  private handleListNamespaces(op: ListNamespacesOperation): string[][] {
    const rows = this.db
      .prepare("SELECT DISTINCT namespace FROM store_items")
      .all() as Array<{ namespace: string }>;

    let namespaces: string[][] = rows.map((r) => JSON.parse(r.namespace));

    // Apply match conditions
    if (op.matchConditions && op.matchConditions.length > 0) {
      for (const condition of op.matchConditions) {
        namespaces = namespaces.filter((ns) =>
          matchesCondition(ns, condition)
        );
      }
    }

    // Apply maxDepth
    if (op.maxDepth != null) {
      namespaces = namespaces
        .map((ns) => ns.slice(0, op.maxDepth!))
        .filter(
          (ns, i, arr) =>
            arr.findIndex((other) => JSON.stringify(other) === JSON.stringify(ns)) === i
        );
    }

    // Apply offset and limit
    const offset = op.offset ?? 0;
    const limit = op.limit ?? 100;
    return namespaces.slice(offset, offset + limit);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function matchesCondition(ns: string[], condition: MatchCondition): boolean {
  const { matchType, path } = condition;

  if (matchType === "prefix") {
    if (path.length > ns.length) return false;
    return path.every((seg, i) => seg === "*" || seg === ns[i]);
  }

  if (matchType === "suffix") {
    if (path.length > ns.length) return false;
    const offset = ns.length - path.length;
    return path.every((seg, i) => seg === "*" || seg === ns[offset + i]);
  }

  return true;
}

/**
 * Simple filter matching: check if the value object matches all filter conditions.
 * Supports direct equality and operator objects ($eq, $ne, $gt, $gte, $lt, $lte).
 */
function matchesFilter(
  value: Record<string, unknown>,
  filter: Record<string, unknown>
): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    const actual = value[key];

    if (condition != null && typeof condition === "object" && !Array.isArray(condition)) {
      const ops = condition as Record<string, unknown>;
      if ("$eq" in ops && actual !== ops.$eq) return false;
      if ("$ne" in ops && actual === ops.$ne) return false;
      if ("$gt" in ops && !(typeof actual === "number" && actual > (ops.$gt as number))) return false;
      if ("$gte" in ops && !(typeof actual === "number" && actual >= (ops.$gte as number))) return false;
      if ("$lt" in ops && !(typeof actual === "number" && actual < (ops.$lt as number))) return false;
      if ("$lte" in ops && !(typeof actual === "number" && actual <= (ops.$lte as number))) return false;
    } else {
      // Direct equality
      if (actual !== condition) return false;
    }
  }
  return true;
}
