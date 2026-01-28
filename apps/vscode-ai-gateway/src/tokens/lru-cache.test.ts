import { describe, expect, it } from "vitest";
import { LRUCache } from "./lru-cache";

describe("LRUCache", () => {
	it("returns undefined for missing keys", () => {
		const cache = new LRUCache<number>(2);
		expect(cache.get("missing")).toBeUndefined();
	});

	it("stores and retrieves values", () => {
		const cache = new LRUCache<number>(2);
		cache.put("a", 1);
		expect(cache.get("a")).toBe(1);
	});

	it("evicts LRU entry when at capacity", () => {
		const cache = new LRUCache<number>(2);
		cache.put("a", 1);
		cache.put("b", 2);
		cache.put("c", 3);

		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe(2);
		expect(cache.get("c")).toBe(3);
	});

	it("moves accessed entries to MRU position", () => {
		const cache = new LRUCache<number>(2);
		cache.put("a", 1);
		cache.put("b", 2);
		cache.get("a");
		cache.put("c", 3);

		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe(1);
		expect(cache.get("c")).toBe(3);
	});

	it("clear removes all entries", () => {
		const cache = new LRUCache<number>(2);
		cache.put("a", 1);
		cache.put("b", 2);
		cache.clear();

		expect(cache.size).toBe(0);
		expect(cache.get("a")).toBeUndefined();
	});
});
